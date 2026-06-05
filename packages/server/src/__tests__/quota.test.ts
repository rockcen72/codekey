// Tests for the approval quota service. Split into two halves:
//   - Pure:  getCurrentPeriod() (no DB, runs locally)
//   - DB:    checkApprovalQuota() + recordApproval() (gated on DATABASE_URL)
//
// The integration half is skipped in local dev (no Postgres) and runs
// in CI where the test DB is provisioned. See CLAUDE.md for the
// test framework conventions.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
	FREE_LIMIT,
	_resetQuotaDedup,
	applyApprovalQuota,
	checkApprovalQuota,
	getCurrentPeriod,
	getUsage,
	recordApproval,
} from "../services/quota.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describe("getCurrentPeriod()", () => {
	it("formats the period as YYYY-MM from a UTC date", () => {
		expect(getCurrentPeriod(new Date("2026-06-05T12:34:56Z"))).toBe("2026-06");
		expect(getCurrentPeriod(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
		expect(getCurrentPeriod(new Date("2026-12-31T23:59:59Z"))).toBe("2026-12");
	});

	it("uses UTC even for the local midnight boundary", () => {
		// 2026-06-30 23:00 UTC = 2026-07-01 07:00 in Asia/Shanghai;
		// the period is anchored to UTC, not the caller's tz.
		expect(getCurrentPeriod(new Date("2026-06-30T23:00:00Z"))).toBe("2026-06");
		expect(getCurrentPeriod(new Date("2026-07-01T00:00:00Z"))).toBe("2026-07");
	});

	it("exports FREE_LIMIT = 50", () => {
		expect(FREE_LIMIT).toBe(50);
	});
});

describeDb("getUsage()", () => {
	let sql: postgres.Sql;
	const cleanupUserIds: number[] = [];

	beforeAll(async () => {
		const { initDb } = await import("../db/init.js");
		sql = await initDb(DATABASE_URL!);
	});

	afterAll(async () => {
		for (const uid of cleanupUserIds) {
			try {
				await sql`DELETE FROM approval_usage WHERE user_id = ${uid}`;
			} catch {
				/* ignore */
			}
			try {
				await sql`DELETE FROM users WHERE id = ${uid}`;
			} catch {
				/* ignore */
			}
		}
		await sql.end();
	});

	beforeEach(async () => {
		await sql`DELETE FROM approval_usage WHERE period = '2099-12'`;
	});

	async function makeUser(): Promise<number> {
		const { buildApp } = await import("../app.js");
		process.env.WECHAT_APPID = process.env.WECHAT_APPID || "mock";
		process.env.USER_JWT_SECRET =
			process.env.USER_JWT_SECRET || "test-secret-" + "x".repeat(40);
		const { app } = await buildApp(DATABASE_URL!);
		const openid = `quota-usage-${Date.now()}-${Math.random()}`;
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/wx-login",
			payload: { code: "c", provider: "wechat", openid },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		cleanupUserIds.push(body.userId);
		await app.close();
		return body.userId;
	}

	it("returns { used: 0, limit: 50 } when no usage row exists", async () => {
		const userId = await makeUser();
		const u = await getUsage(sql, userId, "codekey", "2099-12");
		expect(u).toEqual({ used: 0, limit: FREE_LIMIT, period: "2099-12" });
	});

	it("returns the stored count when a usage row exists", async () => {
		const userId = await makeUser();
		await sql`
			INSERT INTO approval_usage (user_id, product, period, count)
			VALUES (${userId}, 'codekey', '2099-12', 17)
		`;
		const u = await getUsage(sql, userId, "codekey", "2099-12");
		expect(u.used).toBe(17);
		expect(u.limit).toBe(FREE_LIMIT);
		expect(u.period).toBe("2099-12");
	});

	it("returns used=0 for a different period (no cross-period leakage)", async () => {
		const userId = await makeUser();
		await sql`
			INSERT INTO approval_usage (user_id, product, period, count)
			VALUES (${userId}, 'codekey', '2099-11', 30)
		`;
		const u = await getUsage(sql, userId, "codekey", "2099-12");
		expect(u.used).toBe(0);
	});
});

describeDb("checkApprovalQuota()", () => {
	let sql: postgres.Sql;
	const cleanupUserIds: number[] = [];

	beforeAll(async () => {
		const { initDb } = await import("../db/init.js");
		sql = await initDb(DATABASE_URL!);
		// Make sure we don't trip the entitlement cache from a sibling test run.
		const { _resetEntitlementCache } = await import(
			"../services/subscription/index.js"
		);
		_resetEntitlementCache();
	});

	afterAll(async () => {
		for (const uid of cleanupUserIds) {
			for (const t of [
				"approval_events_dedup",
				"approval_usage",
				"trial_claims",
				"user_subscriptions",
				"redeem_logs",
				"device_bindings",
				"auth_identities",
			]) {
				try {
					await sql`DELETE FROM ${sql(t)} WHERE user_id = ${uid}`;
				} catch {
					/* table might not exist or user has no rows — best-effort cleanup */
				}
			}
			try {
				await sql`DELETE FROM users WHERE id = ${uid}`;
			} catch {
				/* ignore */
			}
		}
		await sql.end();
	});

	beforeEach(async () => {
		// Clean quota tables for a fresh period before each test so we don't
		// read counts left over from a previous run.
		await sql`DELETE FROM approval_events_dedup WHERE period = '2099-12'`;
		await sql`DELETE FROM approval_usage WHERE period = '2099-12'`;
		_resetQuotaDedup();
		// Bust entitlement cache between tests so tier changes are reflected.
		const { _resetEntitlementCache } = await import(
			"../services/subscription/index.js"
		);
		_resetEntitlementCache();
	});

	async function makeFreeUser(): Promise<number> {
		// wx-login → creates user row; never claims a device so no trial_claims row.
		const { buildApp } = await import("../app.js");
		process.env.WECHAT_APPID = process.env.WECHAT_APPID || "mock";
		process.env.USER_JWT_SECRET =
			process.env.USER_JWT_SECRET || "test-secret-" + "x".repeat(40);
		const { app } = await buildApp(DATABASE_URL!);
		const openid = `quota-test-${Date.now()}-${Math.random()}`;
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/wx-login",
			payload: { code: "c", provider: "wechat", openid },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		cleanupUserIds.push(body.userId);
		await app.close();
		return body.userId;
	}

	async function makePaidUser(): Promise<number> {
		const userId = await makeFreeUser();
		// Insert a fake active paid row directly — bypasses the mint+redeem flow
		// so the test doesn't depend on the redeem code generator.
		await sql`
			INSERT INTO user_subscriptions (user_id, product, plan, expires_at, source)
			VALUES (${userId}, 'codekey', 'monthly', now() + interval '30 days', 'test')
		`;
		const { _resetEntitlementCache } = await import(
			"../services/subscription/index.js"
		);
		_resetEntitlementCache();
		return userId;
	}

	it("returns { allowed: true, used: 0 } on first check for a free user", async () => {
		const userId = await makeFreeUser();
		const result = await checkApprovalQuota(
			sql,
			userId,
			"client-1",
			"codekey",
			"2099-12",
		);
		expect(result.allowed).toBe(true);
		expect(result.used).toBe(0);
		expect(result.limit).toBe(FREE_LIMIT);
		expect(result.tier).toBe("free");
		expect(result.period).toBe("2099-12");
	});

	it("returns { allowed: true, used: 49 } on 49th check", async () => {
		const userId = await makeFreeUser();
		// Pre-fill 49 counts for the period
		await sql`
			INSERT INTO approval_usage (user_id, product, period, count)
			VALUES (${userId}, 'codekey', '2099-12', 49)
		`;
		const result = await checkApprovalQuota(
			sql,
			userId,
			"client-1",
			"codekey",
			"2099-12",
		);
		expect(result.allowed).toBe(true);
		expect(result.used).toBe(49);
	});

	it("returns { allowed: false, used: 50 } on 50th check", async () => {
		const userId = await makeFreeUser();
		await sql`
			INSERT INTO approval_usage (user_id, product, period, count)
			VALUES (${userId}, 'codekey', '2099-12', 50)
		`;
		const result = await checkApprovalQuota(
			sql,
			userId,
			"client-1",
			"codekey",
			"2099-12",
		);
		expect(result.allowed).toBe(false);
		expect(result.used).toBe(50);
		expect(result.limit).toBe(FREE_LIMIT);
	});

	it("returns { allowed: true, tier: 'paid' } for a paid user regardless of usage", async () => {
		const userId = await makePaidUser();
		// Pre-fill 1000 to prove the limit is bypassed
		await sql`
			INSERT INTO approval_usage (user_id, product, period, count)
			VALUES (${userId}, 'codekey', '2099-12', 1000)
			ON CONFLICT (user_id, product, period) DO UPDATE SET count = 1000
		`;
		const result = await checkApprovalQuota(
			sql,
			userId,
			"client-1",
			"codekey",
			"2099-12",
		);
		expect(result.allowed).toBe(true);
		expect(result.tier).toBe("paid");
		expect(result.used).toBe(0);
		expect(result.skipped).toBe("not_free");
	});
});

describeDb("recordApproval()", () => {
	let sql: postgres.Sql;
	const cleanupUserIds: number[] = [];

	beforeAll(async () => {
		const { initDb } = await import("../db/init.js");
		sql = await initDb(DATABASE_URL!);
		const { _resetEntitlementCache } = await import(
			"../services/subscription/index.js"
		);
		_resetEntitlementCache();
	});

	afterAll(async () => {
		for (const uid of cleanupUserIds) {
			for (const t of [
				"approval_events_dedup",
				"approval_usage",
				"trial_claims",
				"user_subscriptions",
				"device_bindings",
				"auth_identities",
			]) {
				try {
					await sql`DELETE FROM ${sql(t)} WHERE user_id = ${uid}`;
				} catch {
					/* best-effort */
				}
			}
			try {
				await sql`DELETE FROM users WHERE id = ${uid}`;
			} catch {
				/* ignore */
			}
		}
		await sql.end();
	});

	beforeEach(async () => {
		await sql`DELETE FROM approval_events_dedup WHERE period = '2099-12'`;
		await sql`DELETE FROM approval_usage WHERE period = '2099-12'`;
		_resetQuotaDedup();
		const { _resetEntitlementCache } = await import(
			"../services/subscription/index.js"
		);
		_resetEntitlementCache();
	});

	async function makeFreeUser(): Promise<number> {
		const { buildApp } = await import("../app.js");
		process.env.WECHAT_APPID = process.env.WECHAT_APPID || "mock";
		process.env.USER_JWT_SECRET =
			process.env.USER_JWT_SECRET || "test-secret-" + "x".repeat(40);
		const { app } = await buildApp(DATABASE_URL!);
		const openid = `quota-test-${Date.now()}-${Math.random()}`;
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/wx-login",
			payload: { code: "c", provider: "wechat", openid },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		cleanupUserIds.push(body.userId);
		await app.close();
		return body.userId;
	}

	it("creates an approval_usage row at 1 on first call", async () => {
		const userId = await makeFreeUser();
		const r = await recordApproval(sql, userId, "client-1", "codekey", "2099-12");
		expect(r.isNew).toBe(true);
		expect(r.overLimit).toBe(false);
		expect(r.used).toBe(1);

		const [row] = await sql<{ count: number }[]>`
			SELECT count FROM approval_usage WHERE user_id=${userId} AND product='codekey' AND period='2099-12'
		`;
		expect(row.count).toBe(1);
	});

	it("atomically increments existing row", async () => {
		const userId = await makeFreeUser();
		await recordApproval(sql, userId, "c1", "codekey", "2099-12");
		await recordApproval(sql, userId, "c2", "codekey", "2099-12");
		const r = await recordApproval(sql, userId, "c3", "codekey", "2099-12");
		expect(r.isNew).toBe(true);
		expect(r.used).toBe(3);
	});

	it("returns isNew=false and no count change on duplicate clientEventId", async () => {
		const userId = await makeFreeUser();
		const r1 = await recordApproval(sql, userId, "dup", "codekey", "2099-12");
		expect(r1.isNew).toBe(true);
		expect(r1.used).toBe(1);
		const r2 = await recordApproval(sql, userId, "dup", "codekey", "2099-12");
		expect(r2.isNew).toBe(false);
		expect(r2.used).toBe(1); // unchanged
	});

	it("returns overLimit=true (and does not increment) when already at FREE_LIMIT", async () => {
		const userId = await makeFreeUser();
		await sql`
			INSERT INTO approval_usage (user_id, product, period, count)
			VALUES (${userId}, 'codekey', '2099-12', ${FREE_LIMIT})
		`;
		const r = await recordApproval(sql, userId, "c1", "codekey", "2099-12");
		expect(r.isNew).toBe(false);
		expect(r.overLimit).toBe(true);
		expect(r.used).toBe(FREE_LIMIT);

		const [row] = await sql<{ count: number }[]>`
			SELECT count FROM approval_usage WHERE user_id=${userId} AND product='codekey' AND period='2099-12'
		`;
		expect(row.count).toBe(FREE_LIMIT); // unchanged
	});

	it("allows different clientEventIds in the same period", async () => {
		const userId = await makeFreeUser();
		const a = await recordApproval(sql, userId, "a", "codekey", "2099-12");
		const b = await recordApproval(sql, userId, "b", "codekey", "2099-12");
		expect(a.isNew).toBe(true);
		expect(b.isNew).toBe(true);
		expect(b.used).toBe(2);
	});
});

describeDb("applyApprovalQuota()", () => {
	let sql: postgres.Sql;
	const cleanupUserIds: number[] = [];
	const cleanupDeviceIds: string[] = [];

	beforeAll(async () => {
		const { initDb } = await import("../db/init.js");
		sql = await initDb(DATABASE_URL!);
		const { _resetEntitlementCache } = await import(
			"../services/subscription/index.js"
		);
		_resetEntitlementCache();
	});

	afterAll(async () => {
		for (const uid of cleanupUserIds) {
			for (const t of [
				"approval_events_dedup",
				"approval_usage",
				"trial_claims",
				"user_subscriptions",
				"redeem_logs",
				"device_bindings",
				"auth_identities",
			]) {
				try {
					await sql`DELETE FROM ${sql(t)} WHERE user_id = ${uid}`;
				} catch {
					/* best-effort */
				}
			}
			try {
				await sql`DELETE FROM users WHERE id = ${uid}`;
			} catch {
				/* ignore */
			}
		}
		for (const did of cleanupDeviceIds) {
			try {
				await sql`DELETE FROM device_bindings WHERE device_id = ${did}`;
			} catch {
				/* ignore */
			}
		}
		await sql.end();
	});

	beforeEach(async () => {
		await sql`DELETE FROM approval_events_dedup WHERE period = '2099-12'`;
		await sql`DELETE FROM approval_usage WHERE period = '2099-12'`;
		_resetQuotaDedup();
		const { _resetEntitlementCache } = await import(
			"../services/subscription/index.js"
		);
		_resetEntitlementCache();
	});

	async function makeUserAndDevice(): Promise<{
		userId: number;
		deviceId: string;
	}> {
		const { buildApp } = await import("../app.js");
		process.env.WECHAT_APPID = process.env.WECHAT_APPID || "mock";
		process.env.USER_JWT_SECRET =
			process.env.USER_JWT_SECRET || "test-secret-" + "x".repeat(40);
		const { app } = await buildApp(DATABASE_URL!);
		const openid = `quota-test-${Date.now()}-${Math.random()}`;
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/wx-login",
			payload: { code: "c", provider: "wechat", openid },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		cleanupUserIds.push(body.userId);

		// Create a device + binding directly. claim-device would do this
		// but goes through more plumbing; we only need the row.
		const { randomUUID } = await import("node:crypto");
		const deviceId = randomUUID();
		await sql`
			INSERT INTO devices (id, device_name, device_secret) VALUES (${deviceId}, 'test', 'sec')
		`;
		await sql`
			INSERT INTO device_bindings (device_id, user_id, device_name)
			VALUES (${deviceId}, ${body.userId}, 'test')
		`;
		cleanupDeviceIds.push(deviceId);
		await app.close();
		return { userId: body.userId, deviceId };
	}

	async function makePaidDevice(): Promise<string> {
		const { userId, deviceId } = await makeUserAndDevice();
		await sql`
			INSERT INTO user_subscriptions (user_id, product, plan, expires_at, source)
			VALUES (${userId}, 'codekey', 'monthly', now() + interval '30 days', 'test')
		`;
		const { _resetEntitlementCache } = await import(
			"../services/subscription/index.js"
		);
		_resetEntitlementCache();
		return deviceId;
	}

	async function makeUnboundDevice(): Promise<string> {
		const { randomUUID } = await import("node:crypto");
		const deviceId = randomUUID();
		await sql`
			INSERT INTO devices (id, device_name, device_secret) VALUES (${deviceId}, 'unbound', 'sec')
		`;
		cleanupDeviceIds.push(deviceId);
		return deviceId;
	}

	it("returns { kind: 'unlimited' } for a paid user's device", async () => {
		const deviceId = await makePaidDevice();
		const out = await applyApprovalQuota(sql, deviceId, "client-1");
		expect(out.kind).toBe("unlimited");
	});

	it("returns { kind: 'unlimited' } for a device with no binding (fail-open for unpaired)", async () => {
		const deviceId = await makeUnboundDevice();
		const out = await applyApprovalQuota(sql, deviceId, "client-1");
		expect(out.kind).toBe("unlimited");
	});

	it("returns { kind: 'allowed' } for a free user with headroom, incrementing the count", async () => {
		const { userId, deviceId } = await makeUserAndDevice();
		const out = await applyApprovalQuota(sql, deviceId, "client-1");
		expect(out.kind).toBe("allowed");

		const [row] = await sql<{ count: number }[]>`
			SELECT count FROM approval_usage WHERE user_id=${userId} AND period='2099-12'
		`;
		expect(row.count).toBe(1);
	});

	it("returns { kind: 'allowed' } (idempotent) when the same clientEventId arrives twice", async () => {
		const { userId, deviceId } = await makeUserAndDevice();
		const a = await applyApprovalQuota(sql, deviceId, "dup");
		const b = await applyApprovalQuota(sql, deviceId, "dup");
		expect(a.kind).toBe("allowed");
		expect(b.kind).toBe("allowed");

		const [row] = await sql<{ count: number }[]>`
			SELECT count FROM approval_usage WHERE user_id=${userId} AND period='2099-12'
		`;
		expect(row.count).toBe(1); // only one increment
	});

	it("returns { kind: 'over_limit' } when the user is already at FREE_LIMIT", async () => {
		const { userId, deviceId } = await makeUserAndDevice();
		await sql`
			INSERT INTO approval_usage (user_id, product, period, count)
			VALUES (${userId}, 'codekey', '2099-12', ${FREE_LIMIT})
		`;
		const out = await applyApprovalQuota(sql, deviceId, "client-1");
		expect(out.kind).toBe("over_limit");
		if (out.kind !== "over_limit") return;
		expect(out.used).toBe(FREE_LIMIT);
		expect(out.limit).toBe(FREE_LIMIT);
		expect(out.period).toBe("2099-12");
	});

	it("synthesizes a server-side dedup key when clientEventId is null/empty", async () => {
		const { userId, deviceId } = await makeUserAndDevice();
		const a = await applyApprovalQuota(sql, deviceId, null);
		const b = await applyApprovalQuota(sql, deviceId, "");
		expect(a.kind).toBe("allowed");
		expect(b.kind).toBe("allowed");

		// Both events were treated as new (no clientEventId to dedup on)
		const [row] = await sql<{ count: number }[]>`
			SELECT count FROM approval_usage WHERE user_id=${userId} AND period='2099-12'
		`;
		expect(row.count).toBe(2);
	});
});
