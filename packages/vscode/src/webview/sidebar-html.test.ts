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
	it("shows plan status + Manage Subscription button + QQ group for free users", () => {
		const html = renderSubscribe(state({
			subscription: {
				tier: "free",
				plan: null,
				expiresAt: null,
				usage: { used: 12, limit: 50, period: "2026-06" },
			},
		}));

		expect(html).toContain("Free");
		expect(html).toContain("12/50");
		expect(html).toContain("Manage Subscription");
		expect(html).toContain("upgrade-cta");
		expect(html).toContain("827453239");
	});

	it("shows Manage Subscription button for paid users", () => {
		const html = renderSubscribe(state({
			subscription: {
				tier: "paid",
				plan: "monthly",
				expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
				usage: null,
			},
		}));

		expect(html).toContain("Pro");
		expect(html).toContain("Manage Subscription");
		expect(html).toContain("upgrade-cta");
		expect(html).toContain("827453239");
	});

	it("shows Manage Subscription button for trial users", () => {
		const html = renderSubscribe(state({
			subscription: {
				tier: "trial",
				plan: null,
				expiresAt: new Date(Date.now() + 8 * 86400000).toISOString(),
				usage: null,
			},
		}));

		expect(html).toContain("Trial");
		expect(html).toContain("Manage Subscription");
		expect(html).toContain("upgrade-cta");
		expect(html).toContain("827453239");
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
		expect(html).toContain("Join Workspace");
		expect(html).toContain("Pair Device");
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
