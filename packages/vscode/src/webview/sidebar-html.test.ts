import { describe, expect, it } from "vitest";
import { renderSubscribe, type SidebarState } from "./sidebar-html.js";

function state(overrides: Partial<SidebarState> = {}): SidebarState {
	return {
		deviceStatus: "paired",
		phoneName: "",
		bridge: {
			local: "connected",
			relay: "connected",
			updatedAt: Date.now(),
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
	it("shows the Founder 10 purchase CTA for free users", () => {
		const html = renderSubscribe(state({
			subscription: {
				tier: "free",
				plan: null,
				expiresAt: null,
				usage: { used: 12, limit: 50, period: "2026-06" },
			},
		}));

		expect(html).toContain("Founder 10 Pro");
		expect(html).toContain("https://pay.ldxp.cn/shop/6T7QKRTE");
	});
});
