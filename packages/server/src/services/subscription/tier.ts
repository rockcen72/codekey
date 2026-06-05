// Pure tier resolution for getEntitlement(). Extracted from the
// DB-backed function so the decision logic is unit-testable without
// a database. Tier precedence: paid > trial > free. Expiry is a
// strict greater-than check — expires_at === now() is treated as
// already expired, not "just active".

export type Tier = "paid" | "trial" | "free";

export interface Entitlement {
	tier: Tier;
	/** When the current tier expires; null if free (no expiry) or paid-but-expired (caller can show "renewed" CTA). */
	expiresAt: Date | null;
	/** Human-readable plan name (e.g. "monthly", "yearly"); null for free/trial. */
	plan: string | null;
}

export function resolveTier(
	paidExpiresAt: Date | null,
	paidPlan: string | null,
	trialExpiresAt: Date | null,
	now: Date,
): Entitlement {
	if (paidExpiresAt && paidExpiresAt.getTime() > now.getTime()) {
		return { tier: "paid", expiresAt: paidExpiresAt, plan: paidPlan };
	}
	if (trialExpiresAt && trialExpiresAt.getTime() > now.getTime()) {
		return { tier: "trial", expiresAt: trialExpiresAt, plan: null };
	}
	return { tier: "free", expiresAt: null, plan: null };
}
