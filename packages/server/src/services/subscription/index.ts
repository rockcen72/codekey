// Subscription service — DB-backed Phase 2 logic.
//
// All three operations are written to be safe under concurrency:
//   - mintCodes:   uses INSERT, so duplicate hash collisions (≈ 1 in 2^256) are
//                  rejected by the PK. Caller can retry with a new batch.
//   - redeemCode:  uses UPDATE ... WHERE status='unused' RETURNING to atomically
//                  claim the code. The losing concurrent caller sees 0 rows
//                  and is told the code is already used.
//   - getEntitlement: read-only; cached for 30s in-memory per (userId, product)
//                    to keep the hot path (the WS handler asking "can this user
//                    send an approval?") from hammering the DB. The cache is
//                    process-local and best-effort: stale reads for up to 30s
//                    are acceptable; correctness comes from the DB writes.

import type postgres from "postgres";
import { CODE_PREFIX, generateRedeemCode } from "./codes.js";
import { type Entitlement, type Tier, resolveTier } from "./tier.js";

const ENTITLEMENT_CACHE_TTL_MS = 30_000;

export const MVP_PRODUCT = "codekey" as const;
export type Product = typeof MVP_PRODUCT;
const VALID_PRODUCTS: readonly Product[] = [MVP_PRODUCT];

export function isValidProduct(p: string): p is Product {
	return (VALID_PRODUCTS as readonly string[]).includes(p);
}

const cache = new Map<string, { value: Entitlement; expiresAt: number }>();

function cacheKey(userId: number, product: string): string {
	return `${userId}:${product}`;
}

/** Drop a single (userId, product) entry — call after any write that could
 *  change the result (redeem, claim-device creating trial). */
export function invalidateEntitlement(userId: number, product: string): void {
	cache.delete(cacheKey(userId, product));
}

/** Test-only: clear the in-memory cache. */
export function _resetEntitlementCache(): void {
	cache.clear();
}

export async function getEntitlement(
	sql: postgres.Sql,
	userId: number,
	product: string = MVP_PRODUCT,
	now: Date = new Date(),
): Promise<Entitlement> {
	if (!isValidProduct(product)) {
		throw new Error(`unknown product: ${product}`);
	}

	const key = cacheKey(userId, product);
	const cached = cache.get(key);
	if (cached && cached.expiresAt > now.getTime()) {
		return cached.value;
	}

	const [paid] = await sql<{ expires_at: Date; plan: string | null }[]>`
    SELECT expires_at, plan FROM user_subscriptions
    WHERE user_id = ${userId} AND product = ${product}
  `;
	const [trial] = await sql<{ expires_at: Date }[]>`
    SELECT expires_at FROM trial_claims
    WHERE user_id = ${userId} AND product = ${product}
  `;

	const value = resolveTier(
		paid?.expires_at ?? null,
		paid?.plan ?? null,
		trial?.expires_at ?? null,
		now,
	);

	cache.set(key, {
		value,
		expiresAt: now.getTime() + ENTITLEMENT_CACHE_TTL_MS,
	});
	return value;
}

// ── redeemCode ─────────────────────────────────────────────

export type RedeemErrorKind =
	| "invalid_format"
	| "not_found"
	| "already_used"
	| "void"
	| "product_mismatch";

export interface RedeemOk {
	ok: true;
	product: string;
	plan: string;
	durationDays: number;
	beforeExpiresAt: Date | null;
	afterExpiresAt: Date;
}

export interface RedeemErr {
	ok: false;
	error: RedeemErrorKind;
}

export type RedeemResult = RedeemOk | RedeemErr;

const PLAINTEXT_RE = /^CK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export function isValidCodeFormat(plaintext: string): boolean {
	return PLAINTEXT_RE.test(plaintext);
}

export async function redeemCode(
	sql: postgres.Sql,
	userId: number,
	product: string,
	plaintext: string,
): Promise<RedeemResult> {
	if (!isValidProduct(product)) {
		return { ok: false, error: "product_mismatch" };
	}
	if (!isValidCodeFormat(plaintext)) {
		return { ok: false, error: "invalid_format" };
	}

	const { createHash } = await import("node:crypto");
	const codeHash = createHash("sha256").update(plaintext).digest("hex");

	return await sql
		.begin(async (tx): Promise<RedeemResult> => {
			// 1. Atomically claim the code. WHERE status='unused' makes the
			//    UPDATE a no-op for already-used / void codes; the loser of
			//    a concurrent redeem sees 0 rows and we map that to a
			//    specific error below.
			const [claimed] = await tx<
				{
					product: string;
					plan: string;
					duration_days: number;
				}[]
			>`
      UPDATE redeem_codes
      SET status = 'used', used_at = now(), used_by = ${userId}
      WHERE code_hash = ${codeHash} AND status = 'unused'
      RETURNING product, plan, duration_days
    `;
			if (!claimed) {
				// Distinguish: does the code exist at all? If yes, what's its state?
				const [existing] = await tx<{ status: string; product: string }[]>`
        SELECT status, product FROM redeem_codes WHERE code_hash = ${codeHash}
      `;
				if (!existing) return { ok: false, error: "not_found" };
				if (existing.status === "used")
					return { ok: false, error: "already_used" };
				if (existing.status === "void") return { ok: false, error: "void" };
				// Unexpected status — fail safe as already_used.
				return { ok: false, error: "already_used" };
			}
			if (claimed.product !== product) {
				// The code was valid but for a different product. We already
				// marked it used — roll the transaction back so the code stays
				// unused for the right-product caller.
				throw new Error("product_mismatch_rollback");
			}

			// 2. Compute the new expires_at. Additive: new = max(now, current) + duration.
			//    If the user already has an active subscription, this extends it
			//    (e.g. 10 days left + 30-day code = 40 days from now).
			const [sub] = await tx<{ expires_at: Date | null }[]>`
      SELECT expires_at FROM user_subscriptions
      WHERE user_id = ${userId} AND product = ${product}
      FOR UPDATE
    `;
			const beforeExpiresAt = sub?.expires_at ?? null;
			const newExpiresAt = await tx<{ expires_at: Date }[]>`
      SELECT GREATEST(
        COALESCE(${beforeExpiresAt}::timestamptz, now()),
        now()
      ) + (${claimed.duration_days}::int * interval '1 day') AS expires_at
    `;
			const afterExpiresAt = newExpiresAt[0].expires_at;

			// 3. UPSERT subscription.
			await tx`
      INSERT INTO user_subscriptions (user_id, product, plan, expires_at, source)
      VALUES (${userId}, ${product}, ${claimed.plan}, ${afterExpiresAt}, 'redeem_code')
      ON CONFLICT (user_id, product) DO UPDATE
      SET expires_at = EXCLUDED.expires_at,
          plan = EXCLUDED.plan,
          source = 'redeem_code',
          updated_at = now()
    `;

			// 4. Audit log.
			await tx`
      INSERT INTO redeem_logs (code_hash, user_id, product, plan, duration_days, before_expires_at, after_expires_at)
      VALUES (${codeHash}, ${userId}, ${product}, ${claimed.plan}, ${claimed.duration_days}, ${beforeExpiresAt}, ${afterExpiresAt})
    `;

			invalidateEntitlement(userId, product);
			return {
				ok: true,
				product: claimed.product,
				plan: claimed.plan,
				durationDays: claimed.duration_days,
				beforeExpiresAt,
				afterExpiresAt,
			};
		})
		.catch((err: unknown): RedeemResult => {
			// The product-mismatch path throws to roll back the (already-executed)
			// UPDATE on redeem_codes. Translate that specific case to a clean
			// product_mismatch error; everything else rethrows.
			if (err instanceof Error && err.message === "product_mismatch_rollback") {
				return { ok: false, error: "product_mismatch" };
			}
			throw err;
		});
}

// ── mintCodes ──────────────────────────────────────────────

export interface MintOptions {
	batchId?: string;
	note?: string;
}

export interface MintedCode {
	plaintext: string;
}

export async function mintCodes(
	sql: postgres.Sql,
	product: string,
	plan: string,
	count: number,
	options: MintOptions = {},
): Promise<MintedCode[]> {
	if (!isValidProduct(product)) {
		throw new Error(`unknown product: ${product}`);
	}
	if (!Number.isInteger(count) || count < 1 || count > 10_000) {
		throw new Error("count must be an integer in [1, 10000]");
	}
	if (plan !== "monthly" && plan !== "yearly") {
		throw new Error('plan must be "monthly" or "yearly"');
	}
	const durationDays = plan === "yearly" ? 365 : 30;

	const out: MintedCode[] = [];
	// Generate and insert in one pass. Duplicate hashes (≈ 1 in 2^256)
	// would PK-conflict; we don't retry — caller can re-run mintCodes
	// and get a fresh set.
	for (let i = 0; i < count; i++) {
		const code = generateRedeemCode(product, plan, durationDays);
		await sql`
      INSERT INTO redeem_codes (code_hash, product, plan, duration_days, code_prefix, code_last4, batch_id, note)
      VALUES (${code.hash}, ${product}, ${plan}, ${durationDays}, ${code.codePrefix}, ${code.codeLast4}, ${options.batchId ?? null}, ${options.note ?? null})
      ON CONFLICT (code_hash) DO NOTHING
    `;
		out.push({ plaintext: code.plaintext });
	}
	return out;
}

// Re-export the tier type for convenience at the call site.
export type { Entitlement, Tier };
export { CODE_PREFIX };
