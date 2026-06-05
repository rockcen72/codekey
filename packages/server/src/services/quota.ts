// Approval quota service — Phase 3 of the subscription system.
//
// Caps how many approval events a Free-tier user can push through
// the server in a given calendar month. trial / paid users are
// exempt (entitlement check short-circuits the counter). The cap
// is 50 events / user / product / month; the period string is
// YYYY-MM in UTC.
//
// Idempotency: bridges send a `clientEventId` with every event
// (OpenCode's permission.asked and permission.updated share one),
// and we dedupe on that key inside a transaction so a retried
// event can't double-count.
//
// Failure mode: if the DB is unreachable when a Free user tries
// to send an approval, we fail open (let the event through) and
// the caller logs the skip. Hard-blocking approvals on a DB blip
// would be a worse user outcome than briefly letting a few extra
// events through; the count is a soft cap, not a contract.

import type postgres from "postgres";
import {
	MVP_PRODUCT,
	getEntitlement,
	type Tier,
} from "./subscription/index.js";

export const FREE_LIMIT = 50;

export type Product = typeof MVP_PRODUCT;

/** "YYYY-MM" period in UTC, regardless of the caller's timezone.
 *  Exported so tests can pin a deterministic period without
 *  monkey-patching Date.now(). */
export function getCurrentPeriod(now: Date = new Date()): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	return `${y}-${m}`;
}

export interface QuotaCheckResult {
	allowed: boolean;
	/** Current count for the period. 0 for non-free tiers (skipped). */
	used: number;
	/** Cap (0 for non-free tiers; they have no cap). */
	limit: number;
	tier: Tier;
	/** "YYYY-MM" the count applies to. null for non-free tiers (skipped). */
	period: string | null;
	/** Set when the check was skipped (e.g. user is on a paid plan). */
	skipped?: "not_free";
}

/** A snapshot of how many approval events the user has used in the
 *  current period, along with the cap and the period label. Returned
 *  by GET /api/v1/subscription so the mini program can render the
 *  "本月已用 X/50" progress bar. */
export interface UsageSnapshot {
	used: number;
	limit: number;
	period: string;
}

/** Read the current usage counter for a (user, product, period).
 *  Returns 0 when no row exists yet (a fresh month, or a user that
 *  hasn't triggered any approvals). Pure DB read; no entitlement
 *  check, no side effects. */
export async function getUsage(
	sql: postgres.Sql,
	userId: number,
	product: Product = MVP_PRODUCT,
	period: string = getCurrentPeriod(),
): Promise<UsageSnapshot> {
	const [row] = await sql<{ count: number }[]>`
		SELECT count FROM approval_usage
		WHERE user_id = ${userId} AND product = ${product} AND period = ${period}
	`;
	return {
		used: row?.count ?? 0,
		limit: FREE_LIMIT,
		period,
	};
}

export async function checkApprovalQuota(
	sql: postgres.Sql,
	userId: number,
	_clientEventId: string,
	product: Product = MVP_PRODUCT,
	period: string = getCurrentPeriod(),
): Promise<QuotaCheckResult> {
	const ent = await getEntitlement(sql, userId, product);
	if (ent.tier !== "free") {
		return {
			allowed: true,
			used: 0,
			limit: 0,
			tier: ent.tier,
			period: null,
			skipped: "not_free",
		};
	}

	const usage = await getUsage(sql, userId, product, period);
	return {
		allowed: usage.used < FREE_LIMIT,
		used: usage.used,
		limit: FREE_LIMIT,
		tier: "free",
		period,
	};
}

export interface RecordApprovalResult {
	/** true → this call wrote the dedup row + bumped the counter. */
	isNew: boolean;
	/** true → caller's count was already at FREE_LIMIT; we did NOT increment. */
	overLimit: boolean;
	used: number;
}

/** Idempotently record one approval event for the user.
 *
 *  Algorithm (single transaction):
 *    1. SELECT the dedup row for (user, product, period, clientEventId).
 *       If it exists → no-op, return current count.
 *    2. INSERT/UPDATE approval_usage with a `count < FREE_LIMIT` guard.
 *       If 0 rows returned → another caller raced past the cap; do NOT
 *       insert the dedup row, return overLimit.
 *    3. INSERT the dedup row.
 *
 *  The transaction guarantees the dedup row is only written if the
 *  counter was actually incremented.
 */
export async function recordApproval(
	sql: postgres.Sql,
	userId: number,
	clientEventId: string,
	product: Product = MVP_PRODUCT,
	period: string = getCurrentPeriod(),
): Promise<RecordApprovalResult> {
	return await sql.begin(async (tx): Promise<RecordApprovalResult> => {
		// 1. Dedup check
		const [existing] = await tx<{ x: number }[]>`
			SELECT 1 AS x FROM approval_events_dedup
			WHERE user_id = ${userId} AND product = ${product}
			  AND period = ${period} AND client_event_id = ${clientEventId}
		`;
		if (existing) {
			const [row] = await tx<{ count: number }[]>`
				SELECT count FROM approval_usage
				WHERE user_id = ${userId} AND product = ${product} AND period = ${period}
			`;
			return { isNew: false, overLimit: false, used: row?.count ?? 0 };
		}

		// 2. Atomic increment with limit guard. The `WHERE count < FREE_LIMIT`
		//    clause turns this into a no-op when we're at the cap, so a
		//    concurrent caller can't sneak past.
		const [incremented] = await tx<{ count: number }[]>`
			INSERT INTO approval_usage (user_id, product, period, count)
			VALUES (${userId}, ${product}, ${period}, 1)
			ON CONFLICT (user_id, product, period) DO UPDATE
			SET count = approval_usage.count + 1
			WHERE approval_usage.count < ${FREE_LIMIT}
			RETURNING count
		`;
		if (!incremented) {
			// Race lost or already at cap. Read the current count and
			// do NOT write the dedup row, so a later retry can still
			// observe the same cap and behave correctly.
			const [cur] = await tx<{ count: number }[]>`
				SELECT count FROM approval_usage
				WHERE user_id = ${userId} AND product = ${product} AND period = ${period}
			`;
			return {
				isNew: false,
				overLimit: true,
				used: cur?.count ?? FREE_LIMIT,
			};
		}

		// 3. Record the dedup row. If this fails the transaction rolls
		//    back, so we never get a count++ with a missing dedup row.
		await tx`
			INSERT INTO approval_events_dedup (user_id, product, period, client_event_id)
			VALUES (${userId}, ${product}, ${period}, ${clientEventId})
		`;

		return { isNew: true, overLimit: false, used: incremented.count };
	});
}

/** Test-only: clear any in-module state. Currently a no-op (the
 *  service has no process-local cache — entitlement is cached
 *  separately inside the subscription service). Exists so the
 *  test file can call it defensively. */
export function _resetQuotaDedup(): void {
	// intentionally empty; quota has no in-module cache to reset.
}

// ── applyApprovalQuota: the full decision for the WS handler ──────

export type QuotaOutcome =
	/** Paid / trial tier — the cap doesn't apply, push the event normally. */
	| { kind: "unlimited" }
	/** Free tier with headroom — counter was incremented (or the event
	 *  was a duplicate, in which case isNew=false). Push the event normally. */
	| { kind: "allowed" }
	/** Free tier at the cap — do NOT push the event; tell the caller
	 *  to send quota_exceeded to the mini program. */
	| { kind: "over_limit"; used: number; limit: number; period: string }
	/** DB error during the check — fail open, push the event normally.
	 *  Hard-blocking approvals on a transient DB blip would be a worse
	 *  user outcome than briefly letting a few extra events through. */
	| { kind: "fail_open"; reason: string };

/** Resolve a device's user, look up their entitlement, and decide
 *  whether this approval event should be pushed to the mini program.
 *
 *  Failures at any step fall through to `fail_open` (logged, not
 *  thrown) so the WS handler never has to know about transient DB
 *  blips.
 *
 *  `clientEventId` is required for proper dedup — callers must pass
 *  the event's `clientEventId` (or `null` if the bridge didn't
 *  provide one; in that case we synthesize a server-side key so the
 *  dedup table still works).
 */
export async function applyApprovalQuota(
	sql: postgres.Sql,
	deviceId: string,
	clientEventId: string | null,
): Promise<QuotaOutcome> {
	// 1. Find the user behind this device.
	let userId: number;
	try {
		const [binding] = await sql<{ user_id: number }[]>`
			SELECT user_id FROM device_bindings
			WHERE device_id = ${deviceId} AND unbound_at IS NULL
			LIMIT 1
		`;
		if (!binding) {
			// No bound user (e.g. unpaired device) — treat as fail-open
			// rather than fail-closed. Devices that haven't been claimed
			// shouldn't be punished for the user's missing pairing.
			return { kind: "unlimited" };
		}
		userId = binding.user_id;
	} catch (err) {
		console.error("[quota] user lookup failed, fail-open:", err);
		return { kind: "fail_open", reason: "user_lookup" };
	}

	// 2. Check tier. trial / paid → unlimited; free → count.
	let tier: Tier;
	try {
		const ent = await getEntitlement(sql, userId);
		tier = ent.tier;
	} catch (err) {
		console.error("[quota] entitlement lookup failed, fail-open:", err);
		return { kind: "fail_open", reason: "entitlement_lookup" };
	}
	if (tier !== "free") {
		return { kind: "unlimited" };
	}

	// 3. Free user — record and check. Use the event's clientEventId
	//    for dedup; if the bridge didn't provide one, synthesize a
	//    server-side key (rare, but keeps the dedup row unique).
	const dedupKey =
		clientEventId && clientEventId.length > 0
			? clientEventId
			: `srv-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

	try {
		const r = await recordApproval(sql, userId, dedupKey);
		if (r.overLimit) {
			return {
				kind: "over_limit",
				used: r.used,
				limit: FREE_LIMIT,
				period: getCurrentPeriod(),
			};
		}
		return { kind: "allowed" };
	} catch (err) {
		console.error("[quota] record failed, fail-open:", err);
		return { kind: "fail_open", reason: "record" };
	}
}
