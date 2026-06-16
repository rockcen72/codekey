import { describe, expect, it } from "vitest";
import { renderSubscribe, renderPairingContent, type SidebarState, type PairingState } from "./sidebar-html.js";

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

describe("renderPairingContent — feishu QR", () => {
	function pairState(overrides: Partial<PairingState>): SidebarState {
		return state({
			deviceStatus: "unpaired",
			pairing: {
				code: "ABC123",
				method: "qr",
				platform: "feishu",
				status: "idle",
				statusText: "",
				expiresAt: 0,
				...overrides,
			},
		});
	}

	it("renders feishu QR from p.pairUrl when platform=feishu", () => {
		const html = renderPairingContent(pairState({
			pairUrl: "feishu://applink.feishu.cn/client/mini_program/open?appId=cli_xxx&path=pages/bind/bind&query=code%3DABC",
		}));
		expect(html).toContain("id=\"qrFeishu\"");
		expect(html).toContain("<svg"); // QR SVG is rendered
	});

	it("does not render feishu QR when pairUrl is empty (regression guard)", () => {
		const html = renderPairingContent(pairState({ pairUrl: "" }));
		expect(html).not.toContain("qrFeishu");
	});

	it("renders wechat QR from pairUrl when platform=wechat", () => {
		const html = renderPairingContent(pairState({
			platform: "wechat",
			pairUrl: "codekey://pair?code=ABC&key_id=xxx&content_key=yyy&v=1",
		}));
		expect(html).toContain("id=\"qrWechat\"");
	});
});
