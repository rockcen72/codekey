// Cloudflare Worker entry: serves the PayPal-compliant marketing
// site (home + privacy/refund/terms/contact) and lightweight
// PayPal subscription verification APIs for the landing page.
//
// Security primitives (Phase 0):
//   - /api/paypal/webhook verifies PayPal's signature via
//     POST /v1/notifications/verify-webhook-signature before doing
//     anything with the body. Verification failures return 401.
//   - Verified events are forwarded to the relay backend's
//     /internal/paypal/event endpoint, authenticated with a shared
//     bearer token (RELAY_INTERNAL_TOKEN). The Worker is the only
//     thing that should ever call that endpoint.

import type { Env } from "./shared";
import { renderHomePage } from "./home";
import { renderPrivacyPage, renderRefundPage, renderTermsPage, renderContactPage } from "./policies";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

interface PayPalSubscription {
	id: string;
	status?: string;
	plan_id?: string;
	custom_id?: string;
}

const REQUIRED_WEBHOOK_HEADERS = [
	"paypal-transmission-id",
	"paypal-transmission-time",
	"paypal-transmission-sig",
	"paypal-cert-url",
	"paypal-auth-algo",
] as const;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					allow: "GET, HEAD, POST, OPTIONS",
					"cache-control": "public, max-age=86400",
				},
			});
		}

		if (request.method === "GET" || request.method === "HEAD") {
			if (url.pathname === "/") {
				const html = renderHomePage(env);
				const headers = {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "public, max-age=300",
				};
				return new Response(request.method === "HEAD" ? null : html, { headers });
			}
			if (url.pathname === "/robots.txt") {
				return new Response(`User-agent: *
Allow: /
Sitemap: https://tinymoney.ccwu.cc/sitemap.xml

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: Google-Extended
Disallow: /
`, { headers: { "content-type": "text/plain; charset=utf-8" } });
			}
			if (url.pathname === "/sitemap.xml") {
				const text = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://tinymoney.ccwu.cc/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>https://tinymoney.ccwu.cc/privacy</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
  <url><loc>https://tinymoney.ccwu.cc/refund</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
  <url><loc>https://tinymoney.ccwu.cc/terms</loc><changefreq>monthly</changefreq><priority>0.6</priority></url>
  <url><loc>https://tinymoney.ccwu.cc/contact</loc><changefreq>monthly</changefreq><priority>0.5</priority></url>
</urlset>`;
				return new Response(request.method === "HEAD" ? null : text, { headers: { "content-type": "application/xml; charset=utf-8" } });
			}
			const renderer = pickPageRenderer(url.pathname);
			if (renderer) {
				const html = renderer(env);
				const headers = {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "public, max-age=300",
				};
				return new Response(request.method === "HEAD" ? null : html, { headers });
			}
		}

		if (url.pathname === "/api/paypal/webhook" || url.pathname === "/webhook") {
			if (request.method === "GET") {
				return new Response("ok", {
					status: 200,
					headers: { "content-type": "text/plain" },
				});
			}
			if (request.method === "POST") {
				return handleWebhook(request, env);
			}
		}

		if (request.method === "POST" && url.pathname === "/api/paypal/subscription/activate") {
			return handleActivateSubscription(request, env);
		}

		if (request.method === "POST" && url.pathname === "/api/paypal/checkout-redeem") {
			return handleCheckoutRedeem(request, env);
		}

		if (request.method === "GET" && url.pathname === "/api/paypal/checkout-status") {
			return handleCheckoutStatus(request, env);
		}

		return new Response("Not Found", { status: 404 });
	},
};

function pickPageRenderer(pathname: string): ((env: Env) => string) | null {
	switch (pathname) {
		case "/privacy":
		case "/privacy.html":
			return renderPrivacyPage;
		case "/refund":
		case "/refund.html":
			return renderRefundPage;
		case "/terms":
		case "/terms.html":
			return renderTermsPage;
		case "/contact":
		case "/contact.html":
			return renderContactPage;
		default:
			return null;
	}
}

async function handleActivateSubscription(request: Request, env: Env): Promise<Response> {
	try {
		const { subscriptionId, plan } = (await request.json()) as { subscriptionId?: string; plan?: string };
		if (!subscriptionId) return json({ error: "Missing subscriptionId" }, 400);
		if (!isPayPalConfigured(env)) return json({ error: "PayPal is not configured" }, 503);

		// Read-only: ask PayPal for the current state of the subscription
		// so the browser can show an accurate banner. We DO NOT forward
		// anything to the relay backend from this endpoint — it's public
		// and unauthenticated, and forwarding here would let any caller
		// who learns a subscriptionId synthesize "the user paid" events.
		// All authoritative state changes flow through /api/paypal/webhook
		// (signature-verified) → /internal/paypal/event (shared bearer).
		const subscription = await getPayPalSubscription(env, subscriptionId);
		const resolvedPlan = resolvePlanName(env, subscription.plan_id, plan);
		const status = subscription.status || "UNKNOWN";

		return json({
			subscriptionId: subscription.id,
			status,
			plan: resolvedPlan,
			// PayPal says ACTIVE, but the relay backend hasn't necessarily
			// processed the corresponding BILLING.SUBSCRIPTION.ACTIVATED
			// webhook yet. Surface a "syncing" state to the UI rather than
			// a confident "active" so the user doesn't see "subscribed!"
			// before the backend has actually opened Pro.
			syncing: status === "ACTIVE",
			pending: status === "APPROVAL_PENDING" || status === "APPROVED",
		});
	} catch (err) {
		return json({ error: toErrorMessage(err, "Failed to verify subscription") }, 500);
	}
}

async function handleCheckoutRedeem(request: Request, env: Env): Promise<Response> {
	try {
		const { checkoutToken, code } = (await request.json()) as { checkoutToken?: string; code?: string };
		if (!checkoutToken) return json({ error: "Missing checkoutToken" }, 400);
		if (!code) return json({ error: "Missing code" }, 400);

		const base = env.RELAY_BACKEND_URL.replace(/\/+$/, "");
		const resp = await fetch(`${base}/api/v1/checkout-redeem`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ checkoutToken, code }),
		});
		const data = await resp.json();
		return json(data, resp.status);
	} catch (err) {
		return json({ error: toErrorMessage(err, "Failed to redeem code") }, 500);
	}
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
	// Critical: read raw text BEFORE parsing JSON. PayPal's
	// verify-webhook-signature requires the exact original webhook
	// body string; a JSON.parse + JSON.stringify roundtrip is NOT
	// equivalent and will fail verification on whitespace differences.
	const rawBody = await request.text();

	// Collect required headers up front; missing any one => 401.
	const headers: Record<string, string> = {};
	for (const name of REQUIRED_WEBHOOK_HEADERS) {
		const value = request.headers.get(name);
		if (!value) {
			console.warn(`[webhook] missing header: ${name}`);
			return new Response("Unauthorized", { status: 401 });
		}
		headers[name] = value;
	}

	if (!env.PAYPAL_WEBHOOK_ID || env.PAYPAL_WEBHOOK_ID.includes("placeholder")) {
		console.error("[webhook] PAYPAL_WEBHOOK_ID not configured");
		return new Response("Service Unavailable", { status: 503 });
	}

	let webhookEvent: Record<string, unknown>;
	try {
		webhookEvent = JSON.parse(rawBody);
	} catch {
		return new Response("Bad Request", { status: 400 });
	}

	// PayPal's verify-webhook-signature wants the parsed event object,
	// not the raw string. The JSON it parses internally must equal the
	// JSON that was signed — passing the originally-parsed object keeps
	// us safe from re-serialization.
	let verified = false;
	try {
		verified = await verifyWebhookSignature(env, headers, webhookEvent);
	} catch (err) {
		console.error("[webhook] verify call failed:", err);
		return new Response("Unauthorized", { status: 401 });
	}

	if (!verified) {
		return new Response("Unauthorized", { status: 401 });
	}

	const eventId = typeof webhookEvent.id === "string" ? webhookEvent.id : null;
	const eventType = typeof webhookEvent.event_type === "string" ? webhookEvent.event_type : null;
	const resource = (webhookEvent.resource || {}) as Record<string, unknown>;
	const subscriptionId = extractSubscriptionId(eventType, resource);
	const planId = typeof resource.plan_id === "string" ? resource.plan_id : null;
	const customId = extractCustomId(eventType, resource);

	if (!eventId || !eventType) {
		return json({ received: true, ignored: "missing event metadata" });
	}

	// Forward to the relay backend. Failures here mean PayPal will retry
	// the webhook (we return non-2xx). That's the desired behaviour: we
	// never want to ack a webhook we couldn't persist.
	const forward = await forwardToRelay(env, {
		eventId,
		eventType,
		subscriptionId,
		customId,
		plan: resolvePlanName(env, planId),
		// Only send status for subscription lifecycle events; PayPal uses
		// different status values for PAYMENT.SALE.* resources.
		status: eventType?.startsWith("BILLING.SUBSCRIPTION.") && typeof resource.status === "string" ? resource.status : null,
		resource,
	});

	if (!forward.ok) {
		console.error(`[webhook] relay forward failed: ${forward.status} ${forward.body}`);
		return new Response("Internal Error", { status: 500 });
	}

	return json({
		received: true,
		eventId,
		eventType,
		subscriptionId,
		plan: resolvePlanName(env, planId),
	});
}

interface RelayPayload {
	eventId: string;
	eventType: string;
	subscriptionId: string | null;
	customId: string | null;
	plan: string | null;
	status: string | null;
	resource: Record<string, unknown>;
}

async function forwardToRelay(
	env: Env,
	payload: RelayPayload,
): Promise<{ ok: true } | { ok: false; status: number; body: string }> {
	if (!env.RELAY_INTERNAL_TOKEN) {
		return { ok: false, status: 0, body: "RELAY_INTERNAL_TOKEN missing" };
	}
	const base = env.RELAY_BACKEND_URL.replace(/\/+$/, "");
	const resp = await fetch(`${base}/internal/paypal/event`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${env.RELAY_INTERNAL_TOKEN}`,
		},
		body: JSON.stringify(payload),
	});
	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		return { ok: false, status: resp.status, body };
	}
	return { ok: true };
}

async function verifyWebhookSignature(
	env: Env,
	headers: Record<string, string>,
	webhookEvent: Record<string, unknown>,
): Promise<boolean> {
	const accessToken = await getPayPalAccessToken(env);
	const verifyResp = await fetch(`${paypalBaseUrl(env)}/v1/notifications/verify-webhook-signature`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			auth_algo: headers["paypal-auth-algo"],
			cert_url: headers["paypal-cert-url"],
			transmission_id: headers["paypal-transmission-id"],
			transmission_sig: headers["paypal-transmission-sig"],
			transmission_time: headers["paypal-transmission-time"],
			webhook_id: env.PAYPAL_WEBHOOK_ID,
			webhook_event: webhookEvent,
		}),
	});
	if (!verifyResp.ok) {
		const errBody = await verifyResp.text().catch(() => "");
		console.error(`[webhook] PayPal verify returned ${verifyResp.status}: ${errBody}`);
		return false;
	}
	const data = (await verifyResp.json()) as { verification_status?: string };
	return data.verification_status === "SUCCESS";
}

async function getPayPalSubscription(env: Env, subscriptionId: string): Promise<PayPalSubscription> {
	const accessToken = await getPayPalAccessToken(env);
	return paypalFetch<PayPalSubscription>(env, `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	});
}

async function getPayPalAccessToken(env: Env): Promise<string> {
	// Critically: this only needs client credentials, NOT Plan IDs. The
	// webhook signature verifier and the read-only subscription lookup
	// must not be coupled to Plan ID configuration — if a deploy ships
	// only one of the two Plan IDs (or neither), security paths must
	// still work.
	if (!env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_ID.includes("placeholder")) {
		throw new Error("Missing PAYPAL_CLIENT_ID");
	}
	if (!env.PAYPAL_CLIENT_SECRET || env.PAYPAL_CLIENT_SECRET.includes("placeholder")) {
		throw new Error("Missing PAYPAL_CLIENT_SECRET");
	}

	const basic = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
	const resp = await fetch(`${paypalBaseUrl(env)}/v1/oauth2/token`, {
		method: "POST",
		headers: {
			Authorization: `Basic ${basic}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});
	if (!resp.ok) {
		throw new Error(`PayPal auth failed (${resp.status})`);
	}
	const data = (await resp.json()) as { access_token?: string };
	if (!data.access_token) throw new Error("PayPal auth returned no access token");
	return data.access_token;
}

async function paypalFetch<T>(env: Env, path: string, init: RequestInit): Promise<T> {
	const resp = await fetch(`${paypalBaseUrl(env)}${path}`, init);
	const text = await resp.text();
	const data = text ? JSON.parse(text) : null;
	if (!resp.ok) {
		const message = typeof data?.message === "string" ? data.message : `PayPal API failed (${resp.status})`;
		throw new Error(message);
	}
	return data as T;
}

function paypalBaseUrl(env: Env): string {
	return String(env.PAYPAL_ENV || "").toLowerCase() === "live"
		? "https://api-m.paypal.com"
		: "https://api-m.sandbox.paypal.com";
}

function isPayPalConfigured(env: Env): boolean {
	// UX gate only: used by the front-end button rendering to decide
	// whether to show the PayPal SDK or the "use redeem code" fallback.
	// Do NOT use this to gate webhook verification or
	// /v1/billing/subscriptions reads — those only need client credentials
	// and must work even with one Plan ID half-configured.
	return [env.PAYPAL_CLIENT_ID, env.PAYPAL_PLAN_ID_MONTHLY, env.PAYPAL_PLAN_ID_YEARLY]
		.every(value => !!value && !String(value).includes("placeholder"));
}

function resolvePlanName(env: Env, planId?: string | null, fallback?: string): string | null {
	if (planId === env.PAYPAL_PLAN_ID_MONTHLY) return "monthly";
	if (planId === env.PAYPAL_PLAN_ID_YEARLY) return "yearly";
	return fallback || null;
}

/**
 * PayPal stores the subscription_id in different places depending on the
 * event type:
 *
 *   BILLING.SUBSCRIPTION.*       — resource.id IS the subscription_id.
 *   PAYMENT.SALE.COMPLETED       — legacy v1 path; resource.billing_agreement_id
 *                                  carries the subscription_id.
 *   PAYMENT.CAPTURE.COMPLETED    — v2 path used by newer subscription
 *                                  funding sources; the subscription_id
 *                                  is at supplementary_data.related_ids.subscription_id.
 *
 * Returning null here means we cannot attribute the event; the relay
 * backend will log it but cannot open / extend Pro.
 */
function extractSubscriptionId(
	eventType: string | null,
	resource: Record<string, unknown>,
): string | null {
	if (eventType?.startsWith("BILLING.SUBSCRIPTION.")) {
		return typeof resource.id === "string" ? resource.id : null;
	}
	if (typeof resource.billing_agreement_id === "string") {
		return resource.billing_agreement_id;
	}
	const supp = resource.supplementary_data;
	if (supp && typeof supp === "object" && supp !== null) {
		const related = (supp as Record<string, unknown>).related_ids;
		if (related && typeof related === "object" && related !== null) {
			const subId = (related as Record<string, unknown>).subscription_id;
			if (typeof subId === "string") return subId;
		}
	}
	return null;
}

/**
 * customId attribution. For BILLING.SUBSCRIPTION.* events PayPal sets
 * resource.custom_id directly. For payment events the customId from the
 * subscription is sometimes echoed under supplementary_data; if not, the
 * relay backend looks it up via the subscription_id from
 * extractSubscriptionId(). Returning null is fine — the backend will
 * resolve user_id from the persisted (subscription_id → user_id)
 * mapping written at first activation.
 */
function extractCustomId(
	_eventType: string | null,
	resource: Record<string, unknown>,
): string | null {
	if (typeof resource.custom_id === "string") return resource.custom_id;
	const supp = resource.supplementary_data;
	if (supp && typeof supp === "object" && supp !== null) {
		const customId = (supp as Record<string, unknown>).custom_id;
		if (typeof customId === "string") return customId;
	}
	return null;
}

async function handleCheckoutStatus(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const token = url.searchParams.get("checkoutToken") || url.searchParams.get("ct") || "";
	if (!token) return json({ error: "Missing checkoutToken" }, 400);
	const base = env.RELAY_BACKEND_URL.replace(/\/+$/, "");
	const resp = await fetch(`${base}/api/v1/checkout-status?checkoutToken=${encodeURIComponent(token)}`);
	const data = await resp.json();
	return json(data, resp.status);
}

function toErrorMessage(err: unknown, fallback: string): string {
	return err instanceof Error ? err.message : fallback;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
