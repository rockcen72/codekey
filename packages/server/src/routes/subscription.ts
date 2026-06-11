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
import { deviceTokenAuth } from "../auth/middleware.js";
import type { DeviceAuth } from "../auth/middleware.js";
import { rateLimit } from "../middleware/rate-limit.js";
import {
	MVP_PRODUCT,
	getEntitlement,
	mintCodes,
	redeemCode,
} from "../services/subscription/index.js";
import { getUsage } from "../services/quota.js";

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
		//
		// Phase 4: the response also includes a `usage` snapshot for
		// free-tier users so the mini program can render "本月已用
		// X/50" without a second round-trip. trial / paid users get
		// `usage: null` — their cap is unlimited and the UI should
		// either hide the bar or show "不限量".
		fastify.get(
			"/subscription",
			{ preHandler: [userTokenAuth()] },
			async (req) => {
				const userAuth = req.userAuth;
				if (!userAuth) {
					return {
						tier: "free",
						plan: null,
						expiresAt: null,
						product: MVP_PRODUCT,
						usage: null,
					};
				}
				const ent = await getEntitlement(sql, userAuth.userId, MVP_PRODUCT);
				const usage =
					ent.tier === "free"
						? await getUsage(sql, userAuth.userId, MVP_PRODUCT)
						: null;
				return {
					tier: ent.tier,
					plan: ent.plan,
					expiresAt: ent.expiresAt,
					product: MVP_PRODUCT,
					usage,
				};
			},
		);

		// ── GET /api/v1/device-subscription ────────────────────────
		// Same data as /subscription but authenticated via device token
		// (for VS Code sidebar). Looks up the bound user from device_bindings.
		fastify.get(
			"/device-subscription",
			{ preHandler: [deviceTokenAuth(sql)] },
			async (req, reply) => {
				const { deviceId } = (req as unknown as { deviceAuth: DeviceAuth }).deviceAuth;
				const [binding] = await sql`
					SELECT user_id FROM device_bindings WHERE device_id = ${deviceId} LIMIT 1
				`;
				if (!binding) {
					return reply.code(200).send({
						tier: "free",
						plan: null,
						expiresAt: null,
						product: MVP_PRODUCT,
						usage: null,
					});
				}
				const ent = await getEntitlement(sql, binding.user_id, MVP_PRODUCT);
				const usage =
					ent.tier === "free"
						? await getUsage(sql, binding.user_id, MVP_PRODUCT)
						: null;
				return {
					tier: ent.tier,
					plan: ent.plan,
					expiresAt: ent.expiresAt,
					product: MVP_PRODUCT,
					usage,
				};
			},
		);

		// ── POST /api/v1/device-redeem ──────────────────────────
		// Same as /redeem but authenticated via device token
		// (for VS Code sidebar). Looks up the bound user from device_bindings.
		fastify.post(
			"/device-redeem",
			{
				preHandler: [
					deviceTokenAuth(sql),
					rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "device-redeem" }),
				],
			},
			async (req, reply) => {
				const { deviceId } = (req as unknown as { deviceAuth: DeviceAuth }).deviceAuth;
				const { code, product } = (req.body ?? {}) as {
					code?: string;
					product?: string;
				};
				if (!code || typeof code !== "string") {
					return reply.code(400).send({ error: "code required" });
				}
				const [binding] = await sql`
					SELECT user_id FROM device_bindings WHERE device_id = ${deviceId} AND unbound_at IS NULL LIMIT 1
				`;
				if (!binding) {
					return reply.code(400).send({ error: "device not bound" });
				}
				const prod = product ?? MVP_PRODUCT;
				const result = await redeemCode(
					sql,
					binding.user_id,
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
									: 409;
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
	};
}

// Re-export the mint helper for the CLI script.
export { mintCodes, MVP_PRODUCT };
