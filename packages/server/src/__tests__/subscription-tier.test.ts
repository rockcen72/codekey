import { describe, expect, it } from "vitest";
import { type Tier, resolveTier } from "../services/subscription/tier.js";

describe("resolveTier()", () => {
	const now = new Date("2026-06-05T12:00:00Z");

	it('returns "paid" when paid subscription expires in the future', () => {
		const paid = new Date("2026-07-05T12:00:00Z");
		expect(resolveTier(paid, "monthly", null, now).tier).toBe<Tier>("paid");
	});

	it('returns "paid" when paid is active even if trial is also active', () => {
		// paid takes priority over trial
		const paid = new Date("2026-07-05T12:00:00Z");
		const trial = new Date("2026-06-19T12:00:00Z");
		expect(resolveTier(paid, "monthly", trial, now).tier).toBe<Tier>("paid");
	});

	it('returns "paid" with plan="monthly" set on the result', () => {
		const paid = new Date("2026-07-05T12:00:00Z");
		const e = resolveTier(paid, "monthly", null, now);
		expect(e.plan).toBe("monthly");
	});

	it("treats expires_at === now as already expired (not active)", () => {
		// boundary check: expires_at === now() means "just expired"
		const paid = now;
		expect(resolveTier(paid, "monthly", null, now).tier).toBe<Tier>("free");
	});

	it('returns "trial" when trial is active and no paid', () => {
		const trial = new Date("2026-06-19T12:00:00Z");
		expect(resolveTier(null, null, trial, now).tier).toBe<Tier>("trial");
	});

	it('returns "trial" when paid has expired but trial is active', () => {
		const paidExpired = new Date("2026-05-01T00:00:00Z");
		const trial = new Date("2026-06-19T12:00:00Z");
		expect(resolveTier(paidExpired, "monthly", trial, now).tier).toBe<Tier>(
			"trial",
		);
	});

	it('returns "free" when trial has expired and no paid', () => {
		const trialExpired = new Date("2026-06-01T00:00:00Z");
		expect(resolveTier(null, null, trialExpired, now).tier).toBe<Tier>("free");
	});

	it('returns "free" when trial expires exactly at now', () => {
		const trial = now;
		expect(resolveTier(null, null, trial, now).tier).toBe<Tier>("free");
	});

	it('returns "free" when both are null', () => {
		expect(resolveTier(null, null, null, now).tier).toBe<Tier>("free");
	});

	it('returns "free" with plan=null and expiresAt=null', () => {
		const e = resolveTier(null, null, null, now);
		expect(e.plan).toBeNull();
		expect(e.expiresAt).toBeNull();
	});

	it('returns "free" when both are expired', () => {
		const expired = new Date("2025-01-01T00:00:00Z");
		expect(resolveTier(expired, "monthly", expired, now).tier).toBe<Tier>(
			"free",
		);
	});
});
