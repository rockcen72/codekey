// Integration tests for the subscription service + HTTP routes.
// Requires DATABASE_URL to be set; otherwise skipped (run in CI).

import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { signUserJwt } from "../auth/jwt.js";
import {
	_resetEntitlementCache,
	getEntitlement,
	mintCodes,
	redeemCode,
} from "../services/subscription/index.js";

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb("Subscription service (Phase 2)", () => {
	let app: FastifyInstance;
	let sql: postgres.Sql;
	const cleanupUserIds: number[] = [];
	const cleanupCodeHashes: string[] = [];

	beforeAll(async () => {
		process.env.WECHAT_APPID = process.env.WECHAT_APPID || "mock";
		process.env.USER_JWT_SECRET =
			process.env.USER_JWT_SECRET || "test-secret-" + "x".repeat(40);

		const built = await buildApp(DATABASE_URL!);
		app = built.app;
		sql = built.sql;
		_resetEntitlementCache();
	});

	afterAll(async () => {
		for (const uid of cleanupUserIds) {
			try {
				await sql`DELETE FROM redeem_logs WHERE user_id = ${uid}`;
			} catch {
				/* ignore */
			}
			try {
				await sql`DELETE FROM user_subscriptions WHERE user_id = ${uid}`;
			} catch {
				/* ignore */
			}
			try {
				await sql`DELETE FROM trial_claims WHERE user_id = ${uid}`;
			} catch {
				/* ignore */
			}
			try {
				await sql`DELETE FROM device_bindings WHERE user_id = ${uid}`;
			} catch {
				/* ignore */
			}
			try {
				await sql`DELETE FROM auth_identities WHERE user_id = ${uid}`;
			} catch {
				/* ignore */
			}
			try {
				await sql`DELETE FROM users WHERE id = ${uid}`;
			} catch {
				/* ignore */
			}
		}
		for (const h of cleanupCodeHashes) {
			try {
				await sql`DELETE FROM redeem_codes WHERE code_hash = ${h}`;
			} catch {
				/* ignore */
			}
		}
		await app.close();
		await sql.end();
	});

	async function makeUser(): Promise<{ userId: number; token: string }> {
		const openid = `sub-test-${Date.now()}-${Math.random()}`;
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/auth/wx-login",
			payload: { code: "c", provider: "wechat", openid },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		cleanupUserIds.push(body.userId);
		return { userId: body.userId, token: body.token };
	}

	// ── mintCodes ─────────────────────────────────────────────

	it("mintCodes: persists codes with hashed plaintext and returns plaintexts", async () => {
		const batchId = `batch-${Date.now()}-${Math.random()}`;
		const codes = await mintCodes(sql, "codekey", "monthly", 3, {
			batchId,
			note: "unit-test",
		});
		expect(codes.length).toBe(3);
		for (const c of codes) {
			expect(c.plaintext).toMatch(/^CK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
		}

		// Each plaintext is stored only as its SHA-256 hash
		const { createHash } = await import("node:crypto");
		for (const c of codes) {
			const hash = createHash("sha256").update(c.plaintext).digest("hex");
			const [row] = await sql<
				{ product: string; plan: string; status: string; batch_id: string }[]
			>`
        SELECT product, plan, status, batch_id FROM redeem_codes WHERE code_hash = ${hash}
      `;
			expect(row).toBeDefined();
			expect(row.product).toBe("codekey");
			expect(row.plan).toBe("monthly");
			expect(row.status).toBe("unused");
			expect(row.batch_id).toBe(batchId);
			cleanupCodeHashes.push(hash);
		}
	});

	it("mintCodes: rejects unknown product", async () => {
		await expect(mintCodes(sql, "moneynote", "monthly", 1)).rejects.toThrow(
			/unknown product/,
		);
	});

	it("mintCodes: rejects invalid plan", async () => {
		await expect(mintCodes(sql, "codekey", "lifetime", 1)).rejects.toThrow(
			/plan/,
		);
	});

	it("mintCodes: rejects count out of range", async () => {
		await expect(mintCodes(sql, "codekey", "monthly", 0)).rejects.toThrow(
			/count/,
		);
		await expect(mintCodes(sql, "codekey", "monthly", 10_001)).rejects.toThrow(
			/count/,
		);
	});

	it("mintCodes: yearly plan encodes 365-day duration", async () => {
		const codes = await mintCodes(sql, "codekey", "yearly", 1);
		expect(codes.length).toBe(1);
		const { createHash } = await import("node:crypto");
		const hash = createHash("sha256").update(codes[0].plaintext).digest("hex");
		const [row] = await sql<{ duration_days: number }[]>`
      SELECT duration_days FROM redeem_codes WHERE code_hash = ${hash}
    `;
		expect(row.duration_days).toBe(365);
		cleanupCodeHashes.push(hash);
	});

	// ── redeemCode ────────────────────────────────────────────

	it("redeemCode: activates subscription on first redeem", async () => {
		const { userId, token } = await makeUser();
		const [minted] = await mintCodes(sql, "codekey", "monthly", 1);
		const { createHash } = await import("node:crypto");
		cleanupCodeHashes.push(
			createHash("sha256").update(minted.plaintext).digest("hex"),
		);

		const result = await redeemCode(sql, userId, "codekey", minted.plaintext);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.product).toBe("codekey");
		expect(result.plan).toBe("monthly");
		expect(result.durationDays).toBe(30);
		expect(result.beforeExpiresAt).toBeNull();

		const now = new Date();
		const expected = new Date(now.getTime() + 30 * 86_400_000);
		// Allow 5s clock drift between the JS Date.now() and PG now()
		expect(
			Math.abs(result.afterExpiresAt.getTime() - expected.getTime()),
		).toBeLessThan(5_000);

		// GET /api/v1/subscription reflects the new tier
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/subscription",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.tier).toBe("paid");
		expect(body.plan).toBe("monthly");
	});

	it("redeemCode: extends existing subscription additively (max(now, current) + duration)", async () => {
		const { userId } = await makeUser();
		const [a] = await mintCodes(sql, "codekey", "monthly", 1);
		const [b] = await mintCodes(sql, "codekey", "monthly", 1);
		const { createHash } = await import("node:crypto");
		cleanupCodeHashes.push(
			createHash("sha256").update(a.plaintext).digest("hex"),
		);
		cleanupCodeHashes.push(
			createHash("sha256").update(b.plaintext).digest("hex"),
		);

		const r1 = await redeemCode(sql, userId, "codekey", a.plaintext);
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		const firstExpiry = r1.afterExpiresAt.getTime();

		const r2 = await redeemCode(sql, userId, "codekey", b.plaintext);
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;
		// 30 days added on top of the first expiry, not 30 days from now
		const expected = firstExpiry + 30 * 86_400_000;
		expect(Math.abs(r2.afterExpiresAt.getTime() - expected)).toBeLessThan(
			5_000,
		);
		expect(r2.afterExpiresAt.getTime()).toBeGreaterThan(firstExpiry);
	});

	it("redeemCode: rejects invalid format (missing dashes, wrong chars)", async () => {
		const { userId } = await makeUser();
		const r = await redeemCode(sql, userId, "codekey", "not-a-code");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toBe("invalid_format");
	});

	it("redeemCode: returns not_found for well-formed but unknown code", async () => {
		const { userId } = await makeUser();
		// Use a syntactically-valid code that was never minted
		const r = await redeemCode(sql, userId, "codekey", "CK-AAAA-BBBB-CCCC");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toBe("not_found");
	});

	it("redeemCode: returns already_used on second redeem of the same code", async () => {
		const { userId } = await makeUser();
		const [minted] = await mintCodes(sql, "codekey", "monthly", 1);
		const { createHash } = await import("node:crypto");
		cleanupCodeHashes.push(
			createHash("sha256").update(minted.plaintext).digest("hex"),
		);

		const r1 = await redeemCode(sql, userId, "codekey", minted.plaintext);
		expect(r1.ok).toBe(true);

		const { userId: userId2 } = await makeUser();
		const r2 = await redeemCode(sql, userId2, "codekey", minted.plaintext);
		expect(r2.ok).toBe(false);
		if (r2.ok) return;
		expect(r2.error).toBe("already_used");
	});

	it("redeemCode: returns void for codes manually marked void", async () => {
		const { userId } = await makeUser();
		const [minted] = await mintCodes(sql, "codekey", "monthly", 1);
		const { createHash } = await import("node:crypto");
		const hash = createHash("sha256").update(minted.plaintext).digest("hex");
		cleanupCodeHashes.push(hash);
		await sql`UPDATE redeem_codes SET status = 'void' WHERE code_hash = ${hash}`;

		const r = await redeemCode(sql, userId, "codekey", minted.plaintext);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toBe("void");
	});

	it("redeemCode: product_mismatch when code is for a different product", async () => {
		const { userId } = await makeUser();
		// Manually insert a code tagged as a hypothetical "moneynote"
		const { createHash } = await import("node:crypto");
		const fake = "CK-XXXX-YYYY-ZZZZ";
		const hash = createHash("sha256").update(fake).digest("hex");
		cleanupCodeHashes.push(hash);
		await sql`
      INSERT INTO redeem_codes (code_hash, product, plan, duration_days, status)
      VALUES (${hash}, 'moneynote', 'monthly', 30, 'unused')
    `;
		const r = await redeemCode(sql, userId, "codekey", fake);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toBe("product_mismatch");

		// The code should still be 'unused' (transaction rolled back)
		const [row] = await sql<{ status: string }[]>`
      SELECT status FROM redeem_codes WHERE code_hash = ${hash}
    `;
		expect(row.status).toBe("unused");
	});

	it("redeemCode: writes a redeem_logs row on success", async () => {
		const { userId } = await makeUser();
		const [minted] = await mintCodes(sql, "codekey", "monthly", 1);
		const { createHash } = await import("node:crypto");
		const hash = createHash("sha256").update(minted.plaintext).digest("hex");
		cleanupCodeHashes.push(hash);
		await redeemCode(sql, userId, "codekey", minted.plaintext);

		const [row] = await sql<
			{ user_id: number; product: string; duration_days: number }[]
		>`
      SELECT user_id, product, duration_days FROM redeem_logs WHERE code_hash = ${hash}
    `;
		expect(row).toBeDefined();
		expect(row.user_id).toBe(userId);
		expect(row.product).toBe("codekey");
		expect(row.duration_days).toBe(30);
	});

	// ── HTTP /api/v1/redeem ───────────────────────────────────

	it("POST /redeem: 401 without bearer", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/redeem",
			payload: { code: "CK-AAAA-BBBB-CCCC" },
		});
		expect(res.statusCode).toBe(401);
	});

	it("POST /redeem: 400 on missing code", async () => {
		const { token } = await makeUser();
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/redeem",
			headers: { authorization: `Bearer ${token}` },
			payload: {},
		});
		expect(res.statusCode).toBe(400);
	});

	it("POST /redeem: 404 on unknown code", async () => {
		const { token } = await makeUser();
		const res = await app.inject({
			method: "POST",
			url: "/api/v1/redeem",
			headers: { authorization: `Bearer ${token}` },
			payload: { code: "CK-AAAA-BBBB-CCCC" },
		});
		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toBe("not_found");
	});

	it("POST /redeem: 200 on valid code with full entitlement payload", async () => {
		const { userId, token } = await makeUser();
		const [minted] = await mintCodes(sql, "codekey", "monthly", 1);
		const { createHash } = await import("node:crypto");
		cleanupCodeHashes.push(
			createHash("sha256").update(minted.plaintext).digest("hex"),
		);

		const res = await app.inject({
			method: "POST",
			url: "/api/v1/redeem",
			headers: { authorization: `Bearer ${token}` },
			payload: { code: minted.plaintext },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.success).toBe(true);
		expect(body.product).toBe("codekey");
		expect(body.plan).toBe("monthly");
		expect(body.durationDays).toBe(30);
		expect(typeof body.afterExpiresAt).toBe("string");
		expect(userId).toBeGreaterThan(0);
	});

	// ── GET /api/v1/subscription ──────────────────────────────

	it("GET /subscription: returns free tier for new user (no trial, no paid)", async () => {
		const { token } = await makeUser();
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/subscription",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.payload);
		expect(body.tier).toBe("free");
		expect(body.plan).toBeNull();
		expect(body.expiresAt).toBeNull();
		expect(body.product).toBe("codekey");
	});

	it("GET /subscription: returns paid tier after redeem", async () => {
		const { token } = await makeUser();
		const [minted] = await mintCodes(sql, "codekey", "monthly", 1);
		const { createHash } = await import("node:crypto");
		cleanupCodeHashes.push(
			createHash("sha256").update(minted.plaintext).digest("hex"),
		);
		await app.inject({
			method: "POST",
			url: "/api/v1/redeem",
			headers: { authorization: `Bearer ${token}` },
			payload: { code: minted.plaintext },
		});
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/subscription",
			headers: { authorization: `Bearer ${token}` },
		});
		const body = JSON.parse(res.payload);
		expect(body.tier).toBe("paid");
		expect(body.plan).toBe("monthly");
	});

	it("GET /subscription: returns trial tier when trial_claims row exists and no paid", async () => {
		const { userId, token } = await makeUser();
		// Manually plant a trial row (claim-device's auto-insert path is
		// exercised separately; here we test the read side directly).
		await sql`
      INSERT INTO trial_claims (user_id, product) VALUES (${userId}, 'codekey')
    `;
		// Wipe cache so the read goes to DB
		_resetEntitlementCache();
		const res = await app.inject({
			method: "GET",
			url: "/api/v1/subscription",
			headers: { authorization: `Bearer ${token}` },
		});
		const body = JSON.parse(res.payload);
		expect(body.tier).toBe("trial");
	});

	// ── cache ────────────────────────────────────────────────

	it("getEntitlement: returns cached value within TTL", async () => {
		const { userId } = await makeUser();
		_resetEntitlementCache();
		const a = await getEntitlement(sql, userId);
		// Mutate the DB behind the cache's back
		const [minted] = await mintCodes(sql, "codekey", "monthly", 1);
		const { createHash } = await import("node:crypto");
		cleanupCodeHashes.push(
			createHash("sha256").update(minted.plaintext).digest("hex"),
		);
		await redeemCode(sql, userId, "codekey", minted.plaintext);
		// Cache should still return 'free'
		const b = await getEntitlement(sql, userId);
		expect(b.tier).toBe(a.tier);
		expect(b.tier).toBe("free");
	});

	it("getEntitlement: invalidation by redeemCode makes the next read fresh", async () => {
		const { userId } = await makeUser();
		_resetEntitlementCache();
		const a = await getEntitlement(sql, userId);
		expect(a.tier).toBe("free");
		const [minted] = await mintCodes(sql, "codekey", "monthly", 1);
		const { createHash } = await import("node:crypto");
		cleanupCodeHashes.push(
			createHash("sha256").update(minted.plaintext).digest("hex"),
		);
		await redeemCode(sql, userId, "codekey", minted.plaintext);
		// redeemCode calls invalidateEntitlement() internally
		const b = await getEntitlement(sql, userId);
		expect(b.tier).toBe("paid");
	});

	// ── signUserJwt helper sanity ────────────────────────────
	it("signUserJwt: round-trips (used by middleware tests)", () => {
		const token = signUserJwt(42);
		expect(typeof token).toBe("string");
		expect(token.split(".")).toHaveLength(3);
	});
});
