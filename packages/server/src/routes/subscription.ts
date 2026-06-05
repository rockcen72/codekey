// Subscription routes — Phase 2 of the subscription system.
//
//   POST /api/v1/redeem            — exchange a plaintext code for an extended subscription
//   GET  /api/v1/subscription      — return the current user's entitlement snapshot
//
// Both routes require user_token auth (userTokenAuth). The
// /subscription endpoint is the one the mini program polls to render
// "Pro 有效期至 YYYY-MM-DD" / "本月已用 X/50" cards; it must be cheap,
// hence the 30s in-memory cache inside getEntitlement().

import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { userTokenAuth } from "../auth/user-middleware.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
	MVP_PRODUCT,
	getEntitlement,
	mintCodes,
	redeemCode,
} from "../services/subscription/index.js";

export function subscriptionRoutes(sql: postgres.Sql) {
	return async (fastify: FastifyInstance) => {
		// ── POST /api/v1/redeem ──────────────────────────────────
		// Rate limit 10/min per user — generous for legitimate use
		// (one new code per subscription term) but stops brute-force
		// guessing of valid plaintexts.
		fastify.post(
			"/redeem",
			{
				preHandler: [
					userTokenAuth(),
					rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "redeem" }),
				],
			},
			async (req, reply) => {
				const { code, product } = (req.body ?? {}) as {
					code?: string;
					product?: string;
				};
				if (!code || typeof code !== "string") {
					return reply.code(400).send({ error: "code required" });
				}
				const userAuth = req.userAuth;
				if (!userAuth) {
					return reply.code(401).send({ error: "unauthorized" });
				}
				const prod = product ?? MVP_PRODUCT;
				const result = await redeemCode(
					sql,
					userAuth.userId,
					prod,
					code.trim().toUpperCase(),
				);
				if (!result.ok) {
					const status =
						result.error === "invalid_format"
							? 400
							: result.error === "not_found"
								? 404
								: result.error === "product_mismatch"
									? 400
									: 409; // already_used or void
					return reply.code(status).send({ error: result.error });
				}
				return {
					success: true,
					product: result.product,
					plan: result.plan,
					durationDays: result.durationDays,
					beforeExpiresAt: result.beforeExpiresAt,
					afterExpiresAt: result.afterExpiresAt,
				};
			},
		);

		// ── GET /api/v1/subscription ─────────────────────────────
		// Returns the current entitlement for the calling user. Used by
		// the mini program to render the subscription card and to
		// decide whether to display the quota progress bar.
		fastify.get(
			"/subscription",
			{ preHandler: [userTokenAuth()] },
			async (req) => {
				const userAuth = req.userAuth;
				if (!userAuth) {
					return { tier: "free", plan: null, expiresAt: null, product: MVP_PRODUCT };
				}
				const ent = await getEntitlement(sql, userAuth.userId, MVP_PRODUCT);
				return {
					tier: ent.tier,
					plan: ent.plan,
					expiresAt: ent.expiresAt,
					product: MVP_PRODUCT,
				};
			},
		);
	};
}

// Re-export the mint helper for the CLI script.
export { mintCodes, MVP_PRODUCT };
