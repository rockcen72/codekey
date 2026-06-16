import { describe, expect, it } from "vitest";
import { renderSubscribe, type SidebarState } from "./sidebar-html.js";

function state(overrides: Partial<SidebarState> = {}): SidebarState {
	return {
		deviceStatus: "paired",
		phoneName: "",
		bridge: {
			bridge: "running",
			relay: "connected",
			hookInstalled: true,
			hookConfig: "enabled",
			codexHook: "enabled",
			opencodePlugin: "enabled",
			mpOnline: true,
		},
		agents: [],
		pendingApprovals: [],
		sessions: [],
		events: {},
		claudeSessions: [],
		...overrides,
	};
}

describe("renderSubscribe", () => {
	it("shows the Upgrade to Pro CTA for free users", () => {
		const html = renderSubscribe(state({
			subscription: {
				tier: "free",
				plan: null,
				expiresAt: null,
				usage: { used: 12, limit: 50, period: "2026-06" },
			},
		}));

		expect(html).toContain("Upgrade to Pro");
		expect(html).toContain("https://pay.ldxp.cn/shop/6T7QKRTE");
		expect(html).toContain("upgrade-cta");
	});

	it("hides the Upgrade CTA for paid users (sub-row already shows plan)", () => {
		const html = renderSubscribe(state({
			subscription: {
				tier: "paid",
				plan: "monthly",
				expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
				usage: null,
			},
		}));

		expect(html).not.toContain("Upgrade to Pro");
		expect(html).not.toContain("upgrade-cta");
		// Plan label still rendered in sub-row.
		expect(html).toContain("Pro");
	});

	it("hides the Upgrade CTA for trial users (countdown is in sub-row)", () => {
		const html = renderSubscribe(state({
			subscription: {
				tier: "trial",
				plan: null,
				expiresAt: new Date(Date.now() + 8 * 86400000).toISOString(),
				usage: null,
			},
		}));

		expect(html).not.toContain("Upgrade to Pro");
		expect(html).not.toContain("upgrade-cta");
		expect(html).toContain("Trial");
	});
});
