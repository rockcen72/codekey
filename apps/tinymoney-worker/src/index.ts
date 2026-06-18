// Cloudflare Worker entry: serves the PayPal-compliant marketing
// site (home + privacy/refund/terms/contact) and the PayPal order
// API used by the home page's checkout flow.

import type { Env } from "./shared";
import { renderHomePage } from "./home";
import { renderPrivacyPage, renderRefundPage, renderTermsPage, renderContactPage } from "./policies";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// CORS / preflight: respond cheap, never fall through to 404.
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

		if (request.method === "POST" && url.pathname === "/api/paypal/create-order") {
			return handleCreateOrder(request, env);
		}

		if (request.method === "POST" && url.pathname === "/api/paypal/capture-order") {
			return handleCaptureOrder(request, env);
		}

		if (request.method === "POST" && url.pathname === "/api/paypal/webhook") {
			return handleWebhook(request, env);
		}

		return new Response("Not Found", { status: 404 });
	},
};

function pickPageRenderer(pathname: string): ((env: Env) => string) | null {
	switch (pathname) {
		case "/":
			return renderHomePage;
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

async function handleCreateOrder(request: Request, env: Env): Promise<Response> {
	try {
		const { plan } = (await request.json()) as { plan: string };
		const prices: Record<string, { price: string; description: string }> = {
			monthly: { price: "4.99", description: "CodeKey Pro Monthly" },
			yearly: { price: "49.99", description: "CodeKey Pro Yearly" },
		};
		const product = prices[plan];
		if (!product) return json({ error: "Invalid plan" }, 400);

		const accessToken = await getPayPalAccessToken(env);
		const order = await fetch("https://api-m.paypal.com/v2/checkout/orders", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				intent: "CAPTURE",
				purchase_units: [
					{
						description: product.description,
						amount: { currency_code: "USD", value: product.price },
						custom_id: plan,
					},
				],
			}),
		});
		const data: any = await order.json();
		return json({ id: data.id });
	} catch {
		return json({ error: "Failed to create order" }, 500);
	}
}

async function handleCaptureOrder(request: Request, env: Env): Promise<Response> {
	try {
		const { orderId, userId } = (await request.json()) as { orderId: string; userId?: string };
		const accessToken = await getPayPalAccessToken(env);
		const capture = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${orderId}/capture`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
		});
		const data: any = await capture.json();
		if (data.status === "COMPLETED") {
			const plan = data.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id || "monthly";
			const days = plan === "yearly" ? 365 : 30;
			if (userId) {
				await fetch(`${env.RELAY_BACKEND_URL}/api/v1/subscription/activate`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ userId, plan, durationDays: days }),
				}).catch(() => {});
			}
			return json({ status: "COMPLETED", plan, days });
		}
		return json({ status: data.status });
	} catch {
		return json({ error: "Failed to capture order" }, 500);
	}
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
	try {
		const body: any = await request.json();
		if (body.event_type === "CHECKOUT.ORDER.APPROVED") {
			const orderId = body.resource?.id;
			if (orderId) {
				const accessToken = await getPayPalAccessToken(env);
				await fetch(`https://api-m.paypal.com/v2/checkout/orders/${orderId}/capture`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${accessToken}`,
						"Content-Type": "application/json",
					},
				});
			}
		}
		return json({ received: true });
	} catch {
		return json({ error: "Webhook error" }, 500);
	}
}

async function getPayPalAccessToken(env: Env): Promise<string> {
	const basic = btoa(`${env.PAYPAL_CLIENT_ID}:`);
	const resp = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
		method: "POST",
		headers: {
			Authorization: `Basic ${basic}`,
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: "grant_type=client_credentials",
	});
	const data: any = await resp.json();
	return data.access_token;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
