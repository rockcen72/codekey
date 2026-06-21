// Home page: pricing + plans + FAQ + payment CTAs.
// All visible copy goes through i18n (data-i18n attributes); the
// English text in the markup is the fallback when JS is disabled
// or before the i18n script runs (PayPal review crawler reads it).

import type { Env } from "./shared";
import { commonStyles, escapeHtml, renderFooter, renderTopNav } from "./shared";
import { i18nScript } from "./i18n";

export function renderHomePage(env: Env): string {
	const homeI18n = {
		zh: {
			title: "CodeKey Pro",
			subtitle: "\u89e3\u9501\u65e0\u9650\u5ba1\u6279\u3001\u591a\u8bbe\u5907\u7ba1\u7406\u3001\u7aef\u5230\u7aef\u52a0\u5bc6\u548c\u4f18\u5148\u652f\u6301",
			"intro-eyebrow": "\u9762\u5411\u5f00\u53d1\u8005\u7684 AI \u4ee3\u7406\u8fdc\u7a0b\u5ba1\u6279\u5de5\u5177",
			"intro-headline": "\u4e00\u90e8\u624b\u673a\uff0c\u63a5\u4f4f AI \u7684\u6bcf\u4e00\u4e2a\u51b3\u7b56\u3002",
			"intro-body": "CodeKey \u628a VS Code \u4e2d AI \u4ee3\u7406\u7684\u6bcf\u4e00\u4e2a\u5173\u952e\u52a8\u4f5c\u63a8\u9001\u5230\u4f60\u7684\u624b\u673a\u3002\u5728 Telegram\u3001\u5fae\u4fe1\u5c0f\u7a0b\u5e8f\u6216\u98de\u4e66\u91cc\u4e00\u952e\u5141\u8bb8\u6216\u62d2\u7edd\uff0c\u4e0d\u5fc5\u575a\u5b88\u7535\u8111\uff0c\u4e0d\u9519\u8fc7\u4efb\u4f55\u8fdb\u5c55\u3002",
			"shot1-cap": "VS Code \u4fa7\u8fb9\u680f\u751f\u6210\u914d\u5bf9\u7801",
			"shot2-cap": "\u624b\u673a\u5c0f\u7a0b\u5e8f\u67e5\u770b\u4e0e\u5ba1\u6279",
			"shot3-cap": "Telegram \u673a\u5668\u4eba\u4e00\u952e\u54cd\u5e94",
			"feat-title": "\u4ed6\u4eec\u4e3a\u4ec0\u4e48\u9009\u62e9 CodeKey",
			"feat-1-icon": "\u26a1",
			"feat-1-title": "\u5b9e\u65f6\u63a8\u9001",
			"feat-1-desc": "AI \u4ee3\u7406\u4e00\u53d1\u8d77\u52a8\u4f5c\uff0c\u624b\u673a\u7acb\u5373\u6536\u5230\u63a8\u9001\u3002\u5e73\u5747\u5ef6\u8fdf\u4f4e\u4e8e 200 \u6beb\u79d2\u3002",
			"feat-2-icon": "\ud83d\udd12",
			"feat-2-title": "\u7aef\u5230\u7aef\u52a0\u5bc6",
			"feat-2-desc": "\u63d0\u793a\u8bcd\u4e0e\u547d\u4ee4\u5728\u684c\u9762\u4e0e\u624b\u673a\u95f4\u52a0\u5bc6\u4f20\u8f93\uff0c\u670d\u52a1\u5668\u5168\u7a0b\u770b\u4e0d\u5230\u660e\u6587\u3002",
			"feat-3-icon": "\ud83d\udcf1",
			"feat-3-title": "\u591a\u7aef\u540c\u6b65",
			"feat-3-desc": "\u540c\u4e00\u8d26\u53f7\u53ef\u540c\u65f6\u8fde\u591a\u53f0\u684c\u9762 + \u591a\u4e2a\u624b\u673a\u7aef\uff0c\u4f1a\u8bdd\u5b9e\u65f6\u540c\u6b65\u3002",
			"feat-4-icon": "\ud83d\udd0c",
			"feat-4-title": "\u591a\u4ee3\u7406\u517c\u5bb9",
			"feat-4-desc": "\u652f\u6301 Claude Code\u3001Cursor\u3001Codex \u7b49\u4e3b\u6d41 AI \u4ee3\u7406\uff0c\u65e0\u9700\u4fee\u6539\u73b0\u6709\u5de5\u4f5c\u6d41\u3002",
			"product-type-note": "\ud83d\udcbb \u865a\u62df\u8ba2\u9605\u670d\u52a1 \u00b7 \u4ec5\u9650 VS Code \u6269\u5c55\u4f7f\u7528 \u00b7 \u8bd5\u7528\u671f\u540e\u4e0d\u9000\u6b3e \u00b7 <a href=\"/refund\">\u67e5\u770b\u9000\u6b3e\u653f\u7b56</a>",
			"plan-free-name": "Free",
			"plan-free-period": "/\u6708",
			"plan-free-desc": "\u542b 14 \u5929\u8bd5\u7528\uff0c\u4e4b\u540e\u6bcf\u6708 50 \u6b21\u5ba1\u6279",
			"plan-free-f1": "1 \u53f0\u8bbe\u5907",
			"plan-free-f2": "\u6bcf\u6708 50 \u6b21\u5ba1\u6279",
			"plan-free-f3": "\u6709\u9650\u4f1a\u8bdd\u5386\u53f2",
			"plan-free-f4": "\u793e\u533a\u652f\u6301",
			"plan-free-current": "\u5f53\u524d\u5df2\u5728\u4f7f\u7528",
			"plan-monthly-name": "Pro \u6708\u4ed8",
			"plan-monthly-period": "/\u6708",
			"plan-monthly-desc": "\u65e0\u9650\u4f7f\u7528\uff0c\u968f\u65f6\u53d6\u6d88",
			"plan-monthly-btn": "PayPal \u8ba2\u9605",
			"plan-yearly-name": "Pro \u5e74\u4ed8",
			"plan-yearly-period": "/\u5e74",
			"plan-yearly-desc": "\u7701 17% \u2014 $4.17/\u6708",
			"plan-yearly-btn": "PayPal \u8ba2\u9605",
			"plan-pro-f1": "\u65e0\u9650\u8bbe\u5907",
			"plan-pro-f2": "\u65e0\u9650\u5ba1\u6279",
			"plan-pro-f3": "\u5b8c\u6574\u4f1a\u8bdd\u5386\u53f2",
			"plan-pro-f4": "\u7aef\u5230\u7aef\u52a0\u5bc6",
			"plan-pro-f5": "\u4f18\u5148\u652f\u6301",
			"paypal-note": "\ud83d\udcb3 \u652f\u6301 PayPal\u3001\u4fe1\u7528\u5361\u3001\u501f\u8bb0\u5361\u3002\u4e0d\u9ed8\u8ba4\u9009\u4e2d PayPal\uff0c\u60a8\u53ef\u9009\u62e9\u4efb\u4f55\u63a5\u53d7\u7684\u652f\u4ed8\u65b9\u5f0f\u3002\u652f\u4ed8\u6210\u529f\u540e\u81ea\u52a8\u6fc0\u6d3b\u8ba2\u9605\u3002",
			"china-text": "<strong>\ud83c\udde8\ud83c\uddf3 \u56fd\u5185\u7528\u6237\uff1a</strong>\u652f\u6301\u652f\u4ed8\u5b9d\u3001\u5fae\u4fe1\u652f\u4ed8\u3001\u94f6\u884c\u5361\u3002\u8d2d\u4e70\u5151\u6362\u7801\u540e\u5728\u4e0b\u65b9\u8f93\u5165\u6846\u586b\u5199\u5151\u6362\u7801\u6fc0\u6d3b\u3002",
			"china-btn": "\u8d2d\u4e70\u5151\u6362\u7801 \u2192",
			"guide-title": "\u8ba2\u9605\u6307\u5357",
			"guide-1": "<strong>\u9009\u62e9\u65b9\u6848</strong> \u2014 \u70b9\u51fb\u5fc3\u4eea\u65b9\u6848\u4e0b\u7684\u201cPayPal \u8ba2\u9605\u201d\u6309\u94ae",
			"guide-2": "<strong>\u5b8c\u6210\u652f\u4ed8</strong> \u2014 \u767b\u5f55 PayPal \u786e\u8ba4\u652f\u4ed8\uff0c\u8ba2\u9605\u81ea\u52a8\u6fc0\u6d3b",
			"guide-3": "<strong>\u5f00\u59cb\u4f7f\u7528</strong> \u2014 \u5237\u65b0\u624b\u673a\u7aef\u5373\u53ef\u770b\u5230 Pro \u6807\u8bc6",
			"faq-title": "\u5e38\u89c1\u95ee\u9898",
			"faq-1-q": "\u514d\u8d39\u7248\u5305\u542b\u4ec0\u4e48\uff1f",
			"faq-1-a": "\u65b0\u7528\u6237\u9996\u6b21\u914d\u5bf9\u81ea\u52a8\u83b7\u5f97 14 \u5929 Pro \u8bd5\u7528\u3002\u8bd5\u7528\u7ed3\u675f\u540e\u6bcf\u6708 50 \u6b21\u5ba1\u6279\u989d\u5ea6\uff0c\u9650 1 \u53f0\u8bbe\u5907\u3002",
			"faq-2-q": "\u652f\u4ed8\u540e\u5982\u4f55\u6fc0\u6d3b\uff1f",
			"faq-2-a": "PayPal \u652f\u4ed8\u81ea\u52a8\u6fc0\u6d3b\u3002\u56fd\u5185\u652f\u4ed8\u8d2d\u4e70\u7684\u5151\u6362\u7801\uff0c\u8bf7\u5728\u8ba2\u9605\u9875\u9762\u8f93\u5165\u6fc0\u6d3b\u3002",
			"faq-3-q": "\u53ef\u4ee5\u968f\u65f6\u53d6\u6d88\u5417\uff1f",
			"faq-3-a": "\u53ef\u4ee5\u3002\u6708\u4ed8\u548c\u5e74\u4ed8\u5747\u53ef\u968f\u65f6\u53d6\u6d88\uff0c\u5f53\u524d\u5468\u671f\u7ed3\u675f\u540e\u505c\u6b62\u7eed\u8d39\uff0c\u5df2\u652f\u4ed8\u90e8\u5206\u4e0d\u9000\u6b3e\u3002",
			"faq-4-q": "\u201c\u65e0\u9650\u8bbe\u5907\u201d\u662f\u4ec0\u4e48\u610f\u601d\uff1f",
			"faq-4-a": "Pro \u7528\u6237\u53ef\u4ee5\u5728\u591a\u4e2a VS Code \u7a97\u53e3\u6216\u7535\u8111\u4e0a\u914d\u5bf9\u540c\u4e00 CodeKey \u8d26\u53f7\u3002\u514d\u8d39\u7248\u9650 1 \u53f0\u8bbe\u5907\u3002",
			"faq-5-q": "\u8ba2\u9605\u540e\u53ef\u4ee5\u9000\u6b3e\u5417\uff1f",
			"faq-5-a": "\u9996\u6b21\u8ba2\u9605\u542b 14 \u5929\u514d\u8d39\u8bd5\u7528\uff0c\u8bd5\u7528\u671f\u5185\u53d6\u6d88\u5168\u989d\u514d\u8d39\u3002\u8bd5\u7528\u671f\u540e\u8ba2\u9605\u4e3a\u865a\u62df\u670d\u52a1\u4e0d\u63d0\u4f9b\u9000\u6b3e\u3002\u8be6\u89c1<a href=\"/refund\">\u9000\u6b3e\u653f\u7b56</a>\u3002",
			"redeem-title": "\u5151\u6362\u7801\u6fc0\u6d3b",
			"redeem-input-placeholder": "\u8bf7\u8f93\u5165\u5151\u6362\u7801",
			"redeem-btn": "\u6fc0\u6d3b",
			"redeem-success": "\u5151\u6362\u7801\u5df2\u6fc0\u6d3b\uff0c\u8ba2\u9605\u5df2\u751f\u6548\uff01",
			"redeem-error-invalid": "\u5151\u6362\u7801\u65e0\u6548\u6216\u5df2\u8fc7\u671f",
			"redeem-error-expired": "\u914d\u7f6e\u4f1a\u8bdd\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u8ba2\u9605\u9875\u9762",
			badge: "\u63a8\u8350",
		},
		en: {
			title: "CodeKey Pro",
			subtitle: "Unlock unlimited approvals, multi-device support, E2E encryption & priority support",
			"intro-eyebrow": "Remote AI agent approvals for developers",
			"intro-headline": "One phone. Every AI decision in your hands.",
			"intro-body": "CodeKey forwards every critical action your AI agent takes in VS Code straight to your phone. Approve or deny from Telegram, WeChat, or Lark in one tap. No more sitting at your desk; no more missing a step.",
			"shot1-cap": "VS Code sidebar issues a pairing code",
			"shot2-cap": "Mini-app shows the action and decision buttons",
			"shot3-cap": "Telegram bot replies with one tap",
			"feat-title": "Why teams pick CodeKey",
			"feat-1-icon": "\u26a1",
			"feat-1-title": "Real-time push",
			"feat-1-desc": "The moment your agent triggers an action, your phone lights up. Median end-to-end latency under 200&nbsp;ms.",
			"feat-2-icon": "\ud83d\udd12",
			"feat-2-title": "End-to-end encryption",
			"feat-2-desc": "Prompts and commands are encrypted between desktop and phone. Our servers can't read your code.",
			"feat-3-icon": "\ud83d\udcf1",
			"feat-3-title": "Multi-device sync",
			"feat-3-desc": "Pair multiple desktops and phones to one account. Sessions stay in sync everywhere in real time.",
			"feat-4-icon": "\ud83d\udd0c",
			"feat-4-title": "Works with your agents",
			"feat-4-desc": "Native support for Claude Code, Cursor, Codex, and other major AI agents. No workflow changes needed.",
			"product-type-note": "\ud83d\udcbb Digital subscription service \u00b7 VS Code extension only \u00b7 Non-refundable after the 14-day trial \u00b7 <a href=\"/refund\">See refund policy</a>",
			"plan-free-name": "Free",
			"plan-free-period": "/month",
			"plan-free-desc": "14-day trial included, then 50 approvals/month",
			"plan-free-f1": "1 device",
			"plan-free-f2": "50 approvals / month",
			"plan-free-f3": "Limited session history",
			"plan-free-f4": "Community support",
			"plan-free-current": "Currently active",
			"plan-monthly-name": "Pro Monthly",
			"plan-monthly-period": "/month",
			"plan-monthly-desc": "Unlimited everything, cancel anytime",
			"plan-monthly-btn": "Subscribe with PayPal",
			"plan-yearly-name": "Pro Yearly",
			"plan-yearly-period": "/year",
			"plan-yearly-desc": "Save 17% \u2014 $4.17/month",
			"plan-yearly-btn": "Subscribe with PayPal",
			"plan-pro-f1": "Unlimited devices",
			"plan-pro-f2": "Unlimited approvals",
			"plan-pro-f3": "Full session history",
			"plan-pro-f4": "End-to-end encryption",
			"plan-pro-f5": "Priority support",
			"paypal-note": "\ud83d\udcb3 PayPal, credit card, and debit card accepted. PayPal is not pre-selected\u2014you may choose any supported payment method. Subscription activates automatically after payment.",
			"china-text": "<strong>\ud83c\udde8\ud83c\uddf3 China users:</strong> Alipay, WeChat Pay, and bank cards. Buy a redeem code, then enter it in the input box below to activate.",
			"china-btn": "Buy Redeem Code \u2192",
			"guide-title": "How to Subscribe",
			"guide-1": "<strong>Choose a plan</strong> \u2014 Click \"Subscribe with PayPal\" on your preferred plan",
			"guide-2": "<strong>Complete payment</strong> \u2014 Log in to PayPal and confirm. Subscription activates automatically.",
			"guide-3": "<strong>Enjoy</strong> \u2014 Refresh your phone to see the Pro badge",
			"faq-title": "FAQ",
			"faq-1-q": "What's included in the free plan?",
			"faq-1-a": "New users get a 14-day free trial with full Pro features. After the trial, you get 50 approvals per month on 1 device with limited history.",
			"faq-2-q": "How do I activate after payment?",
			"faq-2-a": "PayPal payments activate automatically. For China payments, enter the redeem code on the billing page.",
			"faq-3-q": "Can I cancel anytime?",
			"faq-3-a": "Yes. Monthly and yearly plans can be cancelled anytime. Access continues until the end of the current billing period; already-paid amounts are non-refundable.",
			"faq-4-q": "What does \"unlimited devices\" mean?",
			"faq-4-a": "Pro users can pair multiple VS Code windows or machines to the same CodeKey account. Free plan is limited to 1 device.",
			"faq-5-q": "Can I get a refund?",
			"faq-5-a": "Every new subscription includes a 14-day free trial. Cancel during the trial for no charge. After the trial, the subscription is a digital service and is non-refundable. See <a href=\"/refund\">Refund Policy</a>.",
			"redeem-title": "Redeem Code",
			"redeem-input-placeholder": "Enter your redeem code",
			"redeem-btn": "Redeem",
			"redeem-success": "Redeem code activated! Subscription applied.",
			"redeem-error-invalid": "Invalid or expired redeem code",
			"redeem-error-expired": "Session expired, please re-open the billing page",
			badge: "Recommended",
		},
	};

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeKey Pro &mdash; Subscription</title>
<meta name="google-site-verification" content="L-Uzs0l4RlaaxR4KNNVhdS6YzugJyNbTM8_MJhDEyl8" />
<meta name="description" content="CodeKey Pro subscription. Digital service for VS Code AI agent approvals on phone. PayPal accepted.">
<style>
${commonStyles()}
header.page-hero { text-align: center; margin-bottom: 24px; }
header.page-hero h1 { font-size: 28px; font-weight: 800; margin-bottom: 6px; }
header.page-hero p { color: var(--muted); font-size: 14px; line-height: 1.6; }
.product-type-note { text-align: center; font-size: 12px; color: var(--muted); margin: 0 0 16px; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
.product-type-note a { color: var(--primary); }

/* Product showcase */
.intro { margin: 0 0 32px; text-align: center; }
.intro .eyebrow { display: inline-block; font-size: 11px; font-weight: 800; letter-spacing: 1.2px; text-transform: uppercase; color: var(--primary); padding: 4px 12px; background: rgba(37,99,235,0.08); border-radius: 999px; margin-bottom: 14px; }
.intro h2 { font-size: 24px; font-weight: 800; line-height: 1.25; margin-bottom: 10px; letter-spacing: -0.3px; }
.intro p { color: var(--muted); font-size: 14px; line-height: 1.65; max-width: 640px; margin: 0 auto; }

.shots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 0 0 32px; }
.shot { display: flex; flex-direction: column; }
.shot-frame { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px; aspect-ratio: 3/4; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.shot-frame svg { width: 100%; height: auto; max-height: 100%; display: block; }
.shot-cap { margin-top: 10px; font-size: 12px; color: var(--muted); text-align: center; line-height: 1.5; }

.features { margin: 0 0 32px; }
.features h3 { font-size: 16px; font-weight: 800; text-align: center; margin-bottom: 18px; letter-spacing: -0.2px; }
.feature-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
.feature-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.feature-card .icon { font-size: 22px; line-height: 1; margin-bottom: 8px; }
.feature-card h4 { font-size: 14px; font-weight: 700; margin-bottom: 4px; }
.feature-card p { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0; }

@media (max-width: 720px) {
  .shots { grid-template-columns: 1fr; gap: 12px; }
  .shot-frame { aspect-ratio: 4/3; }
  .feature-grid { grid-template-columns: 1fr; }
  .intro h2 { font-size: 22px; }
}
.plans { display: flex; gap: 12px; margin-bottom: 8px; }
.plan-card { flex: 1; min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; display: flex; flex-direction: column; }
.plan-card.featured { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(37,99,235,0.15); position: relative; }
.plan-card.featured::before { content: attr(data-badge); position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: var(--primary); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 12px; border-radius: 999px; white-space: nowrap; }
.plan-name { font-size: 13px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.plan-price { font-size: 32px; font-weight: 800; margin-bottom: 2px; }
.plan-price span { font-size: 13px; font-weight: 400; color: var(--muted); }
.plan-desc { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
.plan-features { list-style: none; margin-bottom: 16px; flex: 1; }
.plan-features li { padding: 5px 0; font-size: 13px; }
.plan-features li::before { content: "\u2713 "; color: var(--success); font-weight: 700; }
.subscribe-btn { display: block; width: 100%; padding: 10px; border: 0; border-radius: 8px; font-size: 14px; font-weight: 700; text-align: center; cursor: pointer; text-decoration: none; margin-top: auto; }
.subscribe-btn.primary { background: var(--primary); color: #fff; }
.subscribe-btn.primary:hover { background: #1d4ed8; }
.paypal-button-container { margin-top: 8px; min-height: 40px; }
.subscribe-success { text-align: center; padding: 24px 16px; }
.subscribe-success .icon { font-size: 36px; margin-bottom: 10px; }
.subscribe-success h3 { font-size: 16px; font-weight: 800; margin-bottom: 6px; }
.subscribe-success p { font-size: 13px; color: var(--muted); line-height: 1.5; margin: 0; }
.paypal-note { text-align: center; color: var(--muted); font-size: 12px; margin-bottom: 24px; line-height: 1.5; }
.china-row { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 32px; padding: 16px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.china-row-text { color: var(--muted); font-size: 13px; }
.china-row-text strong { color: var(--text); }
.china-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px; border: 0; border-radius: 8px; background: #e53e3e; color: #fff; font-size: 13px; font-weight: 700; text-decoration: none; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.china-btn:hover { background: #c53030; }
.redeem-section { display: none; margin-bottom: 32px; padding: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.redeem-section.visible { display: block; }
.redeem-section h2 { font-size: 15px; font-weight: 800; margin-bottom: 12px; }
.redeem-row { display: flex; gap: 8px; }
.redeem-row input { flex: 1; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; font-family: ui-monospace, Menlo, monospace; background: var(--bg); color: var(--text); outline: none; }
.redeem-row input:focus { border-color: var(--primary); }
.redeem-row button { padding: 10px 20px; border: 0; border-radius: 8px; background: var(--primary); color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; white-space: nowrap; }
.redeem-row button:hover { background: #1d4ed8; }
.redeem-row button:disabled { opacity: 0.5; cursor: not-allowed; }
.redeem-result { margin-top: 12px; font-size: 13px; font-weight: 600; padding: 8px 12px; border-radius: 6px; display: none; }
.redeem-result.success { display: block; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
.redeem-result.error { display: block; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
.guide-section, .faq-section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 24px; }
.guide-section h2, .faq-section h2 { font-size: 15px; font-weight: 800; margin-bottom: 12px; }
.guide-section ol { padding-left: 18px; }
.guide-section li { padding: 5px 0; font-size: 13px; line-height: 1.6; color: var(--muted); }
.guide-section li strong { color: var(--text); }
.faq-item { padding: 10px 0; border-bottom: 1px solid var(--border); }
.faq-item:last-child { border-bottom: 0; }
.faq-q { font-weight: 700; font-size: 13px; margin-bottom: 3px; }
.faq-a { color: var(--muted); font-size: 12px; line-height: 1.6; }
.faq-a a { color: var(--primary); }
.status-banner { display: none; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; font-weight: 600; text-align: center; }
.status-banner.success { display: block; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
.status-banner.error { display: block; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
@media (max-width: 640px) {
  .plans { flex-direction: column; }
  .china-row { flex-direction: column; text-align: center; }
}
</style>
</head>
<body>
<div class="container">
  <div class="lang-bar">
    <button class="lang-btn" id="langToggle" onclick="toggleLang()">\ud83c\udde8\ud83c\uddf3 \u4e2d\u6587</button>
  </div>

  ${renderTopNav("home")}

  <header class="page-hero">
    <h1 data-i18n="title">CodeKey Pro</h1>
    <p data-i18n="subtitle">Unlock unlimited approvals, multi-device support, E2E encryption &amp; priority support</p>
  </header>

  <section class="intro">
    <span class="eyebrow" data-i18n="intro-eyebrow">Remote AI agent approvals for developers</span>
    <h2 data-i18n="intro-headline">One phone. Every AI decision in your hands.</h2>
    <p data-i18n="intro-body">CodeKey forwards every critical action your AI agent takes in VS Code straight to your phone. Approve or deny from Telegram, WeChat, or Lark in one tap. No more sitting at your desk; no more missing a step.</p>
  </section>

  <section class="shots">
    <figure class="shot">
      <div class="shot-frame">
        ${mockVscode()}
      </div>
      <figcaption class="shot-cap" data-i18n="shot1-cap">VS Code sidebar issues a pairing code</figcaption>
    </figure>
    <figure class="shot">
      <div class="shot-frame">
        ${mockMiniapp()}
      </div>
      <figcaption class="shot-cap" data-i18n="shot2-cap">Mini-app shows the action and decision buttons</figcaption>
    </figure>
    <figure class="shot">
      <div class="shot-frame">
        ${mockTelegram()}
      </div>
      <figcaption class="shot-cap" data-i18n="shot3-cap">Telegram bot replies with one tap</figcaption>
    </figure>
  </section>

  <section class="features">
    <h3 data-i18n="feat-title">Why teams pick CodeKey</h3>
    <div class="feature-grid">
      <div class="feature-card">
        <div class="icon" data-i18n="feat-1-icon">\u26a1</div>
        <h4 data-i18n="feat-1-title">Real-time push</h4>
        <p data-i18n="feat-1-desc">The moment your agent triggers an action, your phone lights up. Median end-to-end latency under 200&nbsp;ms.</p>
      </div>
      <div class="feature-card">
        <div class="icon" data-i18n="feat-2-icon">\ud83d\udd12</div>
        <h4 data-i18n="feat-2-title">End-to-end encryption</h4>
        <p data-i18n="feat-2-desc">Prompts and commands are encrypted between desktop and phone. Our servers can't read your code.</p>
      </div>
      <div class="feature-card">
        <div class="icon" data-i18n="feat-3-icon">\ud83d\udcf1</div>
        <h4 data-i18n="feat-3-title">Multi-device sync</h4>
        <p data-i18n="feat-3-desc">Pair multiple desktops and phones to one account. Sessions stay in sync everywhere in real time.</p>
      </div>
      <div class="feature-card">
        <div class="icon" data-i18n="feat-4-icon">\ud83d\udd0c</div>
        <h4 data-i18n="feat-4-title">Works with your agents</h4>
        <p data-i18n="feat-4-desc">Native support for Claude Code, Cursor, Codex, and other major AI agents. No workflow changes needed.</p>
      </div>
    </div>
  </section>

  <p class="product-type-note" data-i18n="product-type-note">\ud83d\udcbb Digital subscription service \u00b7 VS Code extension only \u00b7 Non-refundable after the 14-day trial \u00b7 <a href="/refund">See refund policy</a></p>

  <div id="statusBanner" class="status-banner"></div>

  <div class="plans">
    <div class="plan-card">
      <div class="plan-name" data-i18n="plan-free-name">Free</div>
      <div class="plan-price">$0 <span data-i18n="plan-free-period">/month</span></div>
      <div class="plan-desc" data-i18n="plan-free-desc">14-day trial included, then 50 approvals/month</div>
      <ul class="plan-features">
        <li data-i18n="plan-free-f1">1 device</li>
        <li data-i18n="plan-free-f2">50 approvals / month</li>
        <li data-i18n="plan-free-f3">Limited session history</li>
        <li data-i18n="plan-free-f4">Community support</li>
      </ul>
      <div style="text-align:center;padding:10px 0;color:var(--muted);font-size:12px;" data-i18n="plan-free-current">Currently active</div>
    </div>

    <div class="plan-card featured" data-badge="Recommended">
      <div class="plan-name" data-i18n="plan-monthly-name">Pro Monthly</div>
      <div class="plan-price">$4.99 <span data-i18n="plan-monthly-period">/month</span></div>
      <div class="plan-desc" data-i18n="plan-monthly-desc">Unlimited everything, cancel anytime</div>
      <ul class="plan-features">
        <li data-i18n="plan-pro-f1">Unlimited devices</li>
        <li data-i18n="plan-pro-f2">Unlimited approvals</li>
        <li data-i18n="plan-pro-f3">Full session history</li>
        <li data-i18n="plan-pro-f4">End-to-end encryption</li>
        <li data-i18n="plan-pro-f5">Priority support</li>
      </ul>
      <button class="subscribe-btn primary" onclick="startPayPal('monthly')" data-i18n="plan-monthly-btn">Subscribe with PayPal</button>
      <div class="paypal-button-container" id="paypal-button-monthly" style="display:none"></div>
    </div>

    <div class="plan-card">
      <div class="plan-name" data-i18n="plan-yearly-name">Pro Yearly</div>
      <div class="plan-price">$49.99 <span data-i18n="plan-yearly-period">/year</span></div>
      <div class="plan-desc" data-i18n="plan-yearly-desc">Save 17% \u2014 $4.17/month</div>
      <ul class="plan-features">
        <li data-i18n="plan-pro-f1">Unlimited devices</li>
        <li data-i18n="plan-pro-f2">Unlimited approvals</li>
        <li data-i18n="plan-pro-f3">Full session history</li>
        <li data-i18n="plan-pro-f4">End-to-end encryption</li>
        <li data-i18n="plan-pro-f5">Priority support</li>
      </ul>
      <button class="subscribe-btn primary" onclick="startPayPal('yearly')" data-i18n="plan-yearly-btn">Subscribe with PayPal</button>
      <div class="paypal-button-container" id="paypal-button-yearly" style="display:none"></div>
    </div>
  </div>

  <p class="paypal-note" data-i18n="paypal-note">\ud83d\udcb3 PayPal, credit card, and debit card accepted. PayPal is not pre-selected&mdash;you may choose any supported payment method. Subscription activates automatically after payment.</p>

  <div class="china-row">
    <span class="china-row-text" data-i18n="china-text"><strong>\ud83c\udde8\ud83c\uddf3 China users:</strong> Alipay, WeChat Pay, and bank cards. Buy a redeem code, then activate in VS Code.</span>
    <button class="china-btn" onclick="openRedeem()" data-i18n="china-btn">Buy Redeem Code \u2192</button>
  </div>

  <div id="redeemSection" class="redeem-section">
    <h2 data-i18n="redeem-title">Redeem Code</h2>
    <div class="redeem-row">
      <input id="redeemInput" type="text" placeholder="Enter your redeem code" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false">
      <button id="redeemBtn" onclick="submitRedeem()" data-i18n="redeem-btn">Redeem</button>
    </div>
    <div id="redeemResult" class="redeem-result"></div>
  </div>

  <div class="guide-section">
    <h2 data-i18n="guide-title">How to Subscribe</h2>
    <ol>
      <li data-i18n="guide-1"><strong>Choose a plan</strong> &mdash; Click "Subscribe with PayPal" on your preferred plan</li>
      <li data-i18n="guide-2"><strong>Complete payment</strong> &mdash; Log in to PayPal and confirm. Subscription activates automatically.</li>
      <li data-i18n="guide-3"><strong>Enjoy</strong> &mdash; Refresh your phone to see the Pro badge</li>
    </ol>
  </div>

  <div class="faq-section">
    <h2 data-i18n="faq-title">FAQ</h2>
    <div class="faq-item"><div class="faq-q" data-i18n="faq-1-q">What's included in the free plan?</div><div class="faq-a" data-i18n="faq-1-a">New users get a 14-day free trial with full Pro features. After the trial, you get 50 approvals per month on 1 device with limited history.</div></div>
    <div class="faq-item"><div class="faq-q" data-i18n="faq-2-q">How do I activate after payment?</div><div class="faq-a" data-i18n="faq-2-a">PayPal payments activate automatically. For China payments, enter the redeem code on the billing page.</div></div>
    <div class="faq-item"><div class="faq-q" data-i18n="faq-3-q">Can I cancel anytime?</div><div class="faq-a" data-i18n="faq-3-a">Yes. Monthly and yearly plans can be cancelled anytime. Access continues until the end of the current billing period; already-paid amounts are non-refundable.</div></div>
    <div class="faq-item"><div class="faq-q" data-i18n="faq-4-q">What does "unlimited devices" mean?</div><div class="faq-a" data-i18n="faq-4-a">Pro users can pair multiple VS Code windows or machines to the same CodeKey account. Free plan is limited to 1 device.</div></div>
    <div class="faq-item"><div class="faq-q" data-i18n="faq-5-q">Can I get a refund?</div><div class="faq-a" data-i18n="faq-5-a">Every new subscription includes a 14-day free trial. Cancel during the trial for no charge. After the trial, the subscription is a digital service and is non-refundable. See <a href="/refund">Refund Policy</a>.</div></div>
  </div>
</div>

${renderFooter(env)}

${i18nScript(env, homeI18n)}
<script>
function showStatus(msg, type) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.className = 'status-banner ' + type;
  setTimeout(() => { el.className = 'status-banner'; }, 5000);
}

async function startPayPal(plan) {
  const container = document.getElementById('paypal-button-' + plan);

  const token = getCheckoutToken();
  if (!token) {
    const isZh = document.documentElement.lang.startsWith('zh');
    container.style.display = 'block';
    container.innerHTML = '<div style="padding:14px;border:1px dashed var(--border);border-radius:8px;color:var(--muted);font-size:13px;text-align:center;line-height:1.6">'
      + (isZh
        ? '\u8bf7\u5148\u5b89\u88c5 VS Code \u6269\u5c55\uff0c\u901a\u8fc7\u4fa7\u8fb9\u680f\u8ba2\u9605\u6309\u94ae\u8fdb\u884c\u8ba2\u9605\u3002'
        : 'Install the CodeKey VS Code extension first, then subscribe from the sidebar.')
      + '</div>';
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  try {
    const resp = await fetch('/api/paypal/checkout-status?checkoutToken=' + encodeURIComponent(token));
    const data = await resp.json();
    if (data.hasActive && data.subscription) {
      container.style.display = 'block';
      container.innerHTML = '<div style="padding:14px;border:1px dashed var(--border);border-radius:8px;color:var(--muted);font-size:13px;text-align:center;line-height:1.6">'
        + (currentLang === 'zh'
          ? '\u60a8\u5df2\u6709\u4e00\u4e2a\u6709\u6548\u8ba2\u9605\uff0c\u8bf7\u5148\u53d6\u6d88\u5f53\u524d\u8ba2\u9605\u540e\u518d\u8ba2\u9605\u65b0\u65b9\u6848\u3002'
          : 'You already have an active subscription. Cancel it before subscribing to a different plan.')
        + '</div>';
      container.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
  } catch (_) { /* fall through */ }

  container.style.display = 'block';
  container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (container.dataset.rendered) return;
  container.dataset.rendered = '1';

  if (!PAYPAL_CONFIGURED) {
    container.innerHTML = '<div style="padding:14px;border:1px dashed var(--border);border-radius:8px;color:var(--muted);font-size:13px;text-align:center;line-height:1.6">'
      + (currentLang === 'zh'
        ? 'PayPal \u652f\u4ed8\u6b63\u5728\u63a5\u5165\u4e2d\uff0c\u8bf7\u4f7f\u7528<a href="' + CHINA_PAY_URL + '" target="_blank" rel="noopener" style="color:var(--primary);font-weight:600">\u5151\u6362\u7801\u8d2d\u4e70</a>\u6216\u8054\u7cfb\u5ba2\u670d'
        : 'PayPal checkout is being set up. Please use <a href="' + CHINA_PAY_URL + '" target="_blank" rel="noopener" style="color:var(--primary);font-weight:600">redeem code</a> for now, or contact support')
      + '</div>';
    return;
  }

  loadPayPalSdk()
    .then(() => renderPayPal('paypal-button-' + plan, plan))
    .catch(() => {
      container.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:13px;text-align:center">'
        + (currentLang === 'zh' ? 'PayPal \u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u6216\u4f7f\u7528\u5151\u6362\u7801\u8d2d\u4e70' : 'Failed to load PayPal. Check your network or use a redeem code.')
        + '</div>';
    });
}

let paypalSdkPromise = null;
function loadPayPalSdk() {
  if (paypalSdkPromise) return paypalSdkPromise;
  paypalSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(PAYPAL_CLIENT_ID) + '&currency=USD&vault=true&intent=subscription';
    script.async = true;
    script.dataset.sdkIntegrationSource = 'button-factory';
    const timer = setTimeout(() => reject(new Error('PayPal SDK timeout')), 12000);
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); reject(new Error('PayPal SDK load error')); };
    document.head.appendChild(script);
  });
  return paypalSdkPromise;
}

function getPlanId(plan) {
  if (plan === 'monthly') return PAYPAL_PLAN_ID_MONTHLY;
  if (plan === 'yearly') return PAYPAL_PLAN_ID_YEARLY;
  return '';
}

function getCheckoutToken() {
  // The mobile app / Telegram opens this page with a short-lived
  // checkoutToken signed by the relay backend. We pass it through to
  // PayPal as custom_id so webhook events can be attributed back to
  // the right user.
  const params = new URLSearchParams(window.location.search);
  return params.get('checkoutToken') || params.get('ct') || '';
}

async function confirmSubscription(subscriptionId, plan) {
  const resp = await fetch('/api/paypal/subscription/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscriptionId, plan }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to verify subscription');
  return data;
}

async function onApprove(subscriptionId, plan) {
  try {
    const data = await confirmSubscription(subscriptionId, plan);
    const container = document.getElementById('paypal-button-' + plan);
    if (container) {
      container.innerHTML = '<div class="subscribe-success">'
        + '<div class="icon">&#9989;</div>'
        + '<h3>' + (currentLang === 'zh' ? '\u611f\u8c22\u8ba2\u9605' : 'Thank you for subscribing') + '</h3>'
        + '<p>' + (currentLang === 'zh' ? '\u8ba2\u9605\u5df2\u751f\u6548\uff0c\u8bf7\u8fd4\u56de VS Code \u67e5\u770b\u4f60\u7684 Pro \u72b6\u6001\u3002' : 'Subscription activated. Go back to VS Code to see your Pro status.') + '</p>'
        + '</div>';
      container.style.display = 'block';
    }
  } catch (err) {
    showStatus(currentLang === 'zh' ? '\u652f\u4ed8\u786e\u8ba4\u5931\u8d25\uff0c\u8bf7\u8054\u7cfb\u5ba2\u670d' : 'Payment confirmation failed, please contact support', 'error');
  }
}

async function submitRedeem() {
  const btn = document.getElementById('redeemBtn');
  const input = document.getElementById('redeemInput');
  const resultEl = document.getElementById('redeemResult');
  const token = getCheckoutToken();
  const code = input.value.trim();

  if (!code) return;
  if (!token) {
    resultEl.className = 'redeem-result error';
    resultEl.textContent = currentLang === 'zh' ? '\u914d\u7f6e\u4f1a\u8bdd\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u8ba2\u9605\u9875\u9762' : 'Session expired, please re-open the billing page';
    return;
  }

  // Warn if user has an active subscription
  try {
    const statusResp = await fetch('/api/paypal/checkout-status?checkoutToken=' + encodeURIComponent(token));
    const statusData = await statusResp.json();
    if (statusData.hasActive && !window._redeemConfirmed) {
      resultEl.className = 'redeem-result error';
      resultEl.innerHTML = (currentLang === 'zh'
        ? '\u60a8\u6709\u6d3b\u8dc3\u8ba2\u9605\uff0c\u5151\u6362\u7801\u5c06\u5728\u5f53\u524d\u8ba2\u9605\u5230\u671f\u540e\u751f\u6548\u3002<a href="#" onclick="window._redeemConfirmed=true;document.getElementById(\\'redeemBtn\\').click();return false" style="color:var(--primary);font-weight:600">\u786e\u8ba4\u7ee7\u7eed</a>'
        : 'You have an active subscription. The redeem code will activate after your current subscription expires. <a href="#" onclick="window._redeemConfirmed=true;document.getElementById(\\'redeemBtn\\').click();return false" style="color:var(--primary);font-weight:600">Continue anyway</a>');
      btn.disabled = false;
      return;
    }
  } catch (_) { /* fall through */ }
  window._redeemConfirmed = false;

  btn.disabled = true;
  resultEl.className = 'redeem-result';
  resultEl.textContent = '';

  try {
    const resp = await fetch('/api/paypal/checkout-redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ checkoutToken: token, code }),
    });
    const data = await resp.json();
    if (resp.ok && data.success) {
      const section = document.getElementById('redeemSection');
      if (section) {
        section.innerHTML = '<div class="subscribe-success">'
          + '<div class="icon">&#9989;</div>'
          + '<h3>' + (currentLang === 'zh' ? '\u611f\u8c22\u8ba2\u9605' : 'Thank you for subscribing') + '</h3>'
          + '<p>' + (currentLang === 'zh' ? '\u5151\u6362\u7801\u5df2\u6fc0\u6d3b\uff0c\u8ba2\u9605\u5df2\u751f\u6548\uff0c\u8bf7\u8fd4\u56de VS Code \u67e5\u770b\u4f60\u7684 Pro \u72b6\u6001\u3002' : 'Redeem code activated! Go back to VS Code to see your Pro status.') + '</p>'
          + '</div>';
      }
      input.value = '';
    } else {
      const msg = data && data.error === 'not_found'
        ? (currentLang === 'zh' ? '\u5151\u6362\u7801\u65e0\u6548\u6216\u5df2\u4f7f\u7528' : 'Invalid or already-used redeem code')
        : data && data.error === 'expired'
        ? (currentLang === 'zh' ? '\u914d\u7f6e\u4f1a\u8bdd\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00\u8ba2\u9605\u9875\u9762' : 'Session expired, please re-open the billing page')
        : (currentLang === 'zh' ? '\u5151\u6362\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u5151\u6362\u7801\u5e76\u91cd\u8bd5' : 'Redeem failed, please check your code and try again');
      resultEl.className = 'redeem-result error';
      resultEl.textContent = msg;
    }
  } catch (err) {
    resultEl.className = 'redeem-result error';
    resultEl.textContent = currentLang === 'zh' ? '\u7f51\u7edc\u9519\u8bef\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5' : 'Network error, please try again';
  } finally {
    btn.disabled = false;
  }
}

async function openRedeem() {
  window.open(CHINA_PAY_URL, '_blank');
  document.getElementById('redeemSection').classList.add('visible');

  const token = getCheckoutToken();
  if (token) {
    try {
      const resp = await fetch('/api/paypal/checkout-status?checkoutToken=' + encodeURIComponent(token));
      const data = await resp.json();
      if (data.hasActive && !window._redeemWarningDismissed) {
        document.getElementById('redeemResult').className = 'redeem-result error';
        document.getElementById('redeemResult').innerHTML = (currentLang === 'zh'
          ? '\u60a8\u6709\u6d3b\u8dc3\u8ba2\u9605\uff0c\u5151\u6362\u7801\u5c06\u5728\u5f53\u524d\u8ba2\u9605\u5230\u671f\u540e\u751f\u6548\u3002'
          : 'You have an active subscription. The redeem code will activate after your current subscription expires.');
        return;
      }
    } catch (_) { /* fall through */ }
  }

  if (!token) {
    document.getElementById('redeemResult').className = 'redeem-result';
    document.getElementById('redeemResult').textContent = currentLang === 'zh'
      ? '\u8bf7\u4ece VS Code \u6269\u5c55\u4e2d\u6253\u5f00\u6b64\u9875\u9762\u540e\u6fc0\u6d3b\u5151\u6362\u7801'
      : 'Open from the CodeKey VS Code extension to activate your code';
  }
}

// Show redeem section when this page was opened with a checkoutToken
(function() {
  const token = getCheckoutToken();
  if (token) {
    document.getElementById('redeemSection').classList.add('visible');
  } else {
    const bannerText = function(lang) {
      return lang === 'zh'
        ? '\u8bf7\u5148\u5b89\u88c5 VS Code \u6269\u5c55\uff0c\u901a\u8fc7\u4fa7\u8fb9\u680f\u8ba2\u9605\u6309\u94ae\u8fdb\u884c\u8ba2\u9605\u3002\u5df2\u6709\u5151\u6362\u7801\uff1f\u8bf7\u4ece VS Code \u4fa7\u8fb9\u680f\u70b9\u51fb\u201c\u7ba1\u7406\u8ba2\u9605\u201d\u6253\u5f00\u6b64\u9875\u9762\u540e\u6fc0\u6d3b\u3002'
        : 'Install the CodeKey VS Code extension first, then subscribe from the sidebar. Have a redeem code? Open this page from the VS Code sidebar "Manage Subscription" button to activate it.';
    };
    const showBanner = function(lang) {
      const banner = document.getElementById('statusBanner');
      if (!banner) return;
      banner.className = 'status-banner';
      banner.style.display = 'block';
      banner.style.background = 'rgba(37,99,235,0.08)';
      banner.style.border = '1px solid rgba(37,99,235,0.25)';
      banner.style.color = 'var(--text)';
      banner.innerHTML = bannerText(lang);
    };
    showBanner(currentLang);
    // Update banner text when language toggles (onLangChange is called by i18nScript)
    window.onLangChange = function(lang) { showBanner(lang); };
  }
})();

function renderPayPal(containerId, plan) {
  if (typeof paypal === 'undefined') return;
  const planId = getPlanId(plan);
  if (!planId) {
    showStatus(currentLang === 'zh' ? 'PayPal plan \u914d\u7f6e\u7f3a\u5931' : 'Missing PayPal plan configuration', 'error');
    return;
  }
  paypal.Buttons({
    createSubscription: (data, actions) => actions.subscription.create({
      plan_id: planId,
      custom_id: getCheckoutToken() || undefined,
    }),
    onApprove: (data) => onApprove(data.subscriptionID, plan),
    onError: () => showStatus(currentLang === 'zh' ? 'PayPal \u652f\u4ed8\u51fa\u9519\uff0c\u8bf7\u91cd\u8bd5' : 'PayPal error, please try again', 'error'),
  }).render('#' + containerId);
}
</script>
</body>
</html>`;
}

// ── Mock device screens (inline SVG) ──────────────────────
// Hand-drawn product mockups so the showcase loads instantly,
// works without external image hosting, and renders cleanly for
// PayPal's review crawler.

function mockVscode(): string {
	return `<svg viewBox="0 0 360 480" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="VS Code sidebar showing CodeKey pairing code">
  <defs>
    <linearGradient id="vsBg" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#1e1e1e"/>
      <stop offset="1" stop-color="#252526"/>
    </linearGradient>
  </defs>
  <rect width="360" height="480" rx="10" fill="url(#vsBg)"/>
  <!-- title bar -->
  <rect x="0" y="0" width="360" height="28" rx="10" fill="#3c3c3c"/>
  <rect x="0" y="14" width="360" height="14" fill="#3c3c3c"/>
  <circle cx="14" cy="14" r="5" fill="#ff5f57"/>
  <circle cx="32" cy="14" r="5" fill="#febc2e"/>
  <circle cx="50" cy="14" r="5" fill="#28c840"/>
  <text x="180" y="18" text-anchor="middle" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" fill="#cccccc">project &mdash; Visual Studio Code</text>
  <!-- activity bar -->
  <rect x="0" y="28" width="42" height="452" fill="#333333"/>
  <rect x="6" y="40" width="30" height="30" rx="4" fill="#2563eb" opacity="0.18"/>
  <text x="21" y="60" text-anchor="middle" font-size="14" fill="#cccccc">\u{1F511}</text>
  <text x="21" y="100" text-anchor="middle" font-size="14" fill="#858585">\u{1F4C1}</text>
  <text x="21" y="135" text-anchor="middle" font-size="14" fill="#858585">\u{1F50D}</text>
  <text x="21" y="170" text-anchor="middle" font-size="14" fill="#858585">\u{1F500}</text>
  <text x="21" y="205" text-anchor="middle" font-size="14" fill="#858585">\u{1F41E}</text>
  <!-- sidebar panel -->
  <rect x="42" y="28" width="318" height="452" fill="#252526"/>
  <text x="56" y="56" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#cccccc" letter-spacing="0.5">CODEKEY</text>
  <!-- status -->
  <rect x="56" y="68" width="288" height="34" rx="4" fill="#2d2d30"/>
  <circle cx="68" cy="85" r="4" fill="#16a34a"/>
  <text x="78" y="89" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" fill="#cccccc">Online \u00B7 1 phone connected</text>
  <!-- pairing card -->
  <rect x="56" y="118" width="288" height="146" rx="6" fill="#2d2d30" stroke="#3c3c3c"/>
  <text x="68" y="140" font-family="-apple-system, Segoe UI, sans-serif" font-size="10" font-weight="700" fill="#9ca3af" letter-spacing="0.5">PAIRING CODE</text>
  <text x="200" y="186" text-anchor="middle" font-family="ui-monospace, Menlo, monospace" font-size="32" font-weight="700" fill="#fff" letter-spacing="6">A7K2-9XQ4</text>
  <text x="200" y="208" text-anchor="middle" font-family="-apple-system, Segoe UI, sans-serif" font-size="10" fill="#9ca3af">Expires in 4:58</text>
  <!-- QR placeholder -->
  <rect x="148" y="220" width="104" height="36" rx="4" fill="#1e1e1e"/>
  <text x="200" y="243" text-anchor="middle" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" fill="#2563eb" font-weight="600">Show QR \u2192</text>
  <!-- recent sessions -->
  <text x="56" y="290" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" font-weight="700" fill="#cccccc" letter-spacing="0.5">RECENT SESSIONS</text>
  <rect x="56" y="302" width="288" height="44" rx="4" fill="#2d2d30"/>
  <circle cx="72" cy="324" r="5" fill="#2563eb"/>
  <text x="84" y="320" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" fill="#fff">refactor auth/middleware.ts</text>
  <text x="84" y="334" font-family="-apple-system, Segoe UI, sans-serif" font-size="10" fill="#9ca3af">Claude Code \u00B7 2 pending approvals</text>
  <rect x="56" y="354" width="288" height="44" rx="4" fill="#2d2d30"/>
  <circle cx="72" cy="376" r="5" fill="#16a34a"/>
  <text x="84" y="372" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" fill="#fff">add e2e test for /v1/pair</text>
  <text x="84" y="386" font-family="-apple-system, Segoe UI, sans-serif" font-size="10" fill="#9ca3af">Cursor \u00B7 completed 3m ago</text>
  <!-- footer hint -->
  <rect x="56" y="416" width="288" height="32" rx="4" fill="#1e1e1e" stroke="#3c3c3c"/>
  <text x="200" y="436" text-anchor="middle" font-family="-apple-system, Segoe UI, sans-serif" font-size="10" fill="#9ca3af">Visit tinymoney.ccwu.cc to subscribe</text>
</svg>`;
}

function mockMiniapp(): string {
	return `<svg viewBox="0 0 280 560" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Phone mini-app showing an approval request">
  <!-- phone bezel -->
  <rect x="6" y="6" width="268" height="548" rx="36" fill="#1c1917"/>
  <rect x="14" y="14" width="252" height="532" rx="28" fill="#f5f0eb"/>
  <!-- notch -->
  <rect x="110" y="14" width="60" height="18" rx="9" fill="#1c1917"/>
  <!-- status bar -->
  <text x="32" y="50" font-family="-apple-system, sans-serif" font-size="11" font-weight="600" fill="#1c1917">9:41</text>
  <text x="248" y="50" text-anchor="end" font-family="-apple-system, sans-serif" font-size="11" font-weight="600" fill="#1c1917">\u{1F50B} 87%</text>
  <!-- header -->
  <text x="32" y="86" font-family="-apple-system, sans-serif" font-size="20" font-weight="800" fill="#1c1917">History</text>
  <text x="32" y="104" font-family="-apple-system, sans-serif" font-size="11" fill="#a8a29e">CodeKey AI Remote</text>
  <!-- pills -->
  <rect x="172" y="78" width="42" height="20" rx="10" fill="#fff" stroke="#e7e2dc"/>
  <circle cx="180" cy="88" r="3" fill="#16a34a"/>
  <text x="188" y="92" font-family="-apple-system, sans-serif" font-size="10" font-weight="600" fill="#78716c">Online</text>
  <rect x="220" y="78" width="32" height="20" rx="10" fill="#eff6ff" stroke="#dbeafe"/>
  <text x="236" y="92" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="10" font-weight="700" fill="#2563eb">Pro</text>
  <!-- approval card (highlighted) -->
  <rect x="22" y="124" width="236" height="186" rx="14" fill="#fff" stroke="#2563eb" stroke-width="1.5"/>
  <rect x="22" y="124" width="236" height="32" rx="14" fill="#eff6ff"/>
  <rect x="22" y="138" width="236" height="18" fill="#eff6ff"/>
  <circle cx="38" cy="140" r="4" fill="#2563eb"/>
  <text x="50" y="144" font-family="-apple-system, sans-serif" font-size="11" font-weight="700" fill="#2563eb">Pending approval</text>
  <text x="244" y="144" text-anchor="end" font-family="-apple-system, sans-serif" font-size="10" fill="#78716c">just now</text>
  <text x="34" y="180" font-family="-apple-system, sans-serif" font-size="13" font-weight="700" fill="#1c1917">Run shell command</text>
  <rect x="34" y="190" width="212" height="44" rx="6" fill="#f5f0eb"/>
  <text x="42" y="207" font-family="ui-monospace, Menlo, monospace" font-size="10" fill="#1c1917">$ rm -rf node_modules</text>
  <text x="42" y="222" font-family="ui-monospace, Menlo, monospace" font-size="10" fill="#1c1917">&amp;&amp; pnpm install</text>
  <text x="34" y="252" font-family="-apple-system, sans-serif" font-size="11" fill="#78716c">Claude Code \u00B7 refactor auth/middleware.ts</text>
  <!-- buttons -->
  <rect x="34" y="266" width="100" height="34" rx="8" fill="#2563eb"/>
  <text x="84" y="288" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="13" font-weight="700" fill="#fff">Approve</text>
  <rect x="146" y="266" width="100" height="34" rx="8" fill="#fff" stroke="#e7e2dc"/>
  <text x="196" y="288" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="13" font-weight="700" fill="#1c1917">Deny</text>
  <!-- earlier item -->
  <rect x="22" y="324" width="236" height="74" rx="14" fill="#fff" stroke="#e7e2dc"/>
  <circle cx="38" cy="344" r="4" fill="#16a34a"/>
  <text x="50" y="348" font-family="-apple-system, sans-serif" font-size="11" font-weight="700" fill="#16a34a">Approved</text>
  <text x="34" y="372" font-family="-apple-system, sans-serif" font-size="12" font-weight="600" fill="#1c1917">Write file: src/api/auth.ts</text>
  <text x="34" y="388" font-family="-apple-system, sans-serif" font-size="10" fill="#a8a29e">Cursor \u00B7 3m ago</text>
  <!-- earlier item 2 -->
  <rect x="22" y="412" width="236" height="74" rx="14" fill="#fff" stroke="#e7e2dc"/>
  <circle cx="38" cy="432" r="4" fill="#dc2626"/>
  <text x="50" y="436" font-family="-apple-system, sans-serif" font-size="11" font-weight="700" fill="#dc2626">Denied</text>
  <text x="34" y="460" font-family="-apple-system, sans-serif" font-size="12" font-weight="600" fill="#1c1917">Push to main branch</text>
  <text x="34" y="476" font-family="-apple-system, sans-serif" font-size="10" fill="#a8a29e">Codex \u00B7 12m ago</text>
  <!-- home indicator -->
  <rect x="100" y="528" width="80" height="4" rx="2" fill="#1c1917"/>
</svg>`;
}

function mockTelegram(): string {
	return `<svg viewBox="0 0 280 560" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Telegram chat showing CodeKey approval bot">
  <!-- phone bezel -->
  <rect x="6" y="6" width="268" height="548" rx="36" fill="#1c1917"/>
  <rect x="14" y="14" width="252" height="532" rx="28" fill="#ffffff"/>
  <rect x="110" y="14" width="60" height="18" rx="9" fill="#1c1917"/>
  <!-- chat header -->
  <rect x="14" y="34" width="252" height="64" fill="#517da2"/>
  <text x="36" y="58" font-family="-apple-system, sans-serif" font-size="14" font-weight="600" fill="#fff">\u{2190}</text>
  <circle cx="74" cy="66" r="16" fill="#fff"/>
  <text x="74" y="70" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="14" font-weight="800" fill="#517da2">CK</text>
  <text x="100" y="62" font-family="-apple-system, sans-serif" font-size="13" font-weight="700" fill="#fff">CodeKey Bot</text>
  <text x="100" y="78" font-family="-apple-system, sans-serif" font-size="10" fill="#cfdcec">bot \u00B7 typing\u2026</text>
  <!-- chat background -->
  <rect x="14" y="98" width="252" height="430" fill="#e6ebee"/>
  <text x="140" y="120" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="10" font-weight="600" fill="#7e8a96">Today</text>
  <!-- bot bubble: pending approval -->
  <rect x="22" y="134" width="220" height="160" rx="12" fill="#fff"/>
  <text x="32" y="156" font-family="-apple-system, sans-serif" font-size="11" font-weight="700" fill="#2563eb">\u{26A1} New approval request</text>
  <text x="32" y="178" font-family="-apple-system, sans-serif" font-size="12" font-weight="700" fill="#1c1917">Action: Run shell command</text>
  <rect x="32" y="186" width="200" height="36" rx="6" fill="#f5f0eb"/>
  <text x="40" y="202" font-family="ui-monospace, Menlo, monospace" font-size="10" fill="#1c1917">$ rm -rf node_modules</text>
  <text x="40" y="216" font-family="ui-monospace, Menlo, monospace" font-size="10" fill="#1c1917">&amp;&amp; pnpm install</text>
  <text x="32" y="238" font-family="-apple-system, sans-serif" font-size="10" fill="#7e8a96">From: Claude Code on MacBook Pro</text>
  <!-- inline keyboard -->
  <rect x="32" y="248" width="94" height="32" rx="6" fill="#eaf3ff" stroke="#b6d3f0"/>
  <text x="79" y="269" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="12" font-weight="600" fill="#2563eb">\u2705 Approve</text>
  <rect x="138" y="248" width="94" height="32" rx="6" fill="#fff" stroke="#e7e2dc"/>
  <text x="185" y="269" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="12" font-weight="600" fill="#1c1917">\u274C Deny</text>
  <text x="234" y="307" text-anchor="end" font-family="-apple-system, sans-serif" font-size="10" fill="#7e8a96">9:41 AM</text>
  <!-- user reply -->
  <rect x="118" y="318" width="124" height="36" rx="12" fill="#dcf8c6"/>
  <text x="180" y="340" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="13" font-weight="600" fill="#1c1917">\u2705 Approve</text>
  <text x="234" y="367" text-anchor="end" font-family="-apple-system, sans-serif" font-size="10" fill="#7e8a96">9:41 AM \u2713\u2713</text>
  <!-- bot confirm -->
  <rect x="22" y="380" width="180" height="64" rx="12" fill="#fff"/>
  <text x="32" y="402" font-family="-apple-system, sans-serif" font-size="11" font-weight="700" fill="#16a34a">\u2713 Approval delivered</text>
  <text x="32" y="420" font-family="-apple-system, sans-serif" font-size="11" fill="#1c1917">Action executing on desktop\u2026</text>
  <text x="32" y="436" font-family="-apple-system, sans-serif" font-size="10" fill="#7e8a96">Roundtrip: 184 ms</text>
  <text x="194" y="457" text-anchor="end" font-family="-apple-system, sans-serif" font-size="10" fill="#7e8a96">9:41 AM</text>
  <!-- bot done -->
  <rect x="22" y="468" width="160" height="48" rx="12" fill="#fff"/>
  <text x="32" y="490" font-family="-apple-system, sans-serif" font-size="11" font-weight="700" fill="#16a34a">\u2713 Completed</text>
  <text x="32" y="506" font-family="-apple-system, sans-serif" font-size="10" fill="#7e8a96">Exit code 0 \u00B7 12.4s</text>
  <!-- input bar -->
  <rect x="14" y="528" width="252" height="18" fill="#fff"/>
  <rect x="100" y="540" width="80" height="4" rx="2" fill="#1c1917"/>
</svg>`;
}

// ── Fallback page (no checkout token) ────────────────────

export function renderFallbackPage(env: Env): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeKey &mdash; Subscription</title>
<meta name="google-site-verification" content="L-Uzs0l4RlaaxR4KNNVhdS6YzugJyNbTM8_MJhDEyl8" />
<meta name="description" content="CodeKey Pro subscription">
<style>
${commonStyles()}
.fallback { text-align: center; padding: 64px 16px 48px; }
.fallback-icon { font-size: 48px; margin-bottom: 20px; }
.fallback h1 { font-size: 22px; font-weight: 800; margin-bottom: 12px; letter-spacing: -0.3px; }
.fallback p { color: var(--muted); font-size: 14px; line-height: 1.7; max-width: 480px; margin: 0 auto 24px; }
.fallback .steps { text-align: left; max-width: 400px; margin: 0 auto 32px; }
.fallback .step { padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 13px; line-height: 1.6; display: flex; gap: 10px; }
.fallback .step:last-child { border-bottom: 0; }
.fallback .step-num { flex-shrink: 0; width: 22px; height: 22px; background: var(--primary); color: #fff; border-radius: 50%; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.fallback .step-text { flex: 1; color: var(--muted); }
.fallback .step-text strong { color: var(--text); }
.fallback-links { display: flex; flex-direction: column; gap: 10px; align-items: center; }
.fallback-btn { display: inline-flex; align-items: center; gap: 6px; padding: 12px 24px; border-radius: 8px; font-size: 14px; font-weight: 700; text-decoration: none; cursor: pointer; }
.fallback-btn.primary { background: var(--primary); color: #fff; }
.fallback-btn.primary:hover { background: #1d4ed8; }
.fallback-btn.secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
.fallback-btn.secondary:hover { border-color: var(--primary); color: var(--primary); }
.fallback-meta { font-size: 12px; color: var(--muted); margin-top: 32px; }
.fallback-meta a { color: var(--primary); }
</style>
</head>
<body>
<div class="container">
  ${renderTopNav("home")}

  <div class="fallback">
    <div class="fallback-icon">🔑</div>
    <h1 data-i18n="fallback-title">Please open from VS Code</h1>
    <p data-i18n="fallback-desc">This subscription page requires a secure session from the CodeKey VS Code extension. Please open it from the sidebar to manage your subscription.</p>

    <div class="steps">
      <div class="step"><span class="step-num">1</span><span class="step-text" data-i18n="fallback-step-1"><strong>Open VS Code</strong> and click the CodeKey icon in the Activity Bar</span></div>
      <div class="step"><span class="step-num">2</span><span class="step-text" data-i18n="fallback-step-2">In the <strong>CodeKey sidebar</strong>, click <strong>"Manage Subscription"</strong></span></div>
    </div>

    <div class="fallback-links">
      <a class="fallback-btn primary" href="https://marketplace.visualstudio.com/items?itemName=CodeKey.codekey-vscode" target="_blank" rel="noopener noreferrer" data-i18n="fallback-install-btn">📦 Install CodeKey Extension</a>
      <div class="fallback-meta">
        <span data-i18n="fallback-qq">QQ Group</span>: <a href="https://qm.qq.com/q/ryWvbgYpNY" target="_blank" rel="noopener noreferrer">827453239</a>
        &nbsp;·&nbsp;
        <span data-i18n="fallback-email">Email</span>: <a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a>
      </div>
    </div>
  </div>
</div>
${renderFooter(env)}
<script>
const i18n = {
  zh: {
    "fallback-title": "请从 VS Code 打开",
    "fallback-desc": "此订阅页面需要 CodeKey VS Code 扩展的安全会话。请从 VS Code 侧边栏打开以管理您的订阅。",
    "fallback-step-1": "<strong>打开 VS Code</strong>，点击左侧活动栏中的 CodeKey 图标",
    "fallback-step-2": "在 <strong>CodeKey 侧边栏</strong>中，点击 <strong>&quot;管理订阅&quot;</strong>",
    "fallback-install-btn": "📦 安装 CodeKey 扩展",
    "fallback-qq": "QQ 群",
    "fallback-email": "邮箱",
  },
  en: {
    "fallback-title": "Please open from VS Code",
    "fallback-desc": "This subscription page requires a secure session from the CodeKey VS Code extension. Please open it from the sidebar to manage your subscription.",
    "fallback-step-1": "<strong>Open VS Code</strong> and click the CodeKey icon in the Activity Bar",
    "fallback-step-2": "In the <strong>CodeKey sidebar</strong>, click <strong>&quot;Manage Subscription&quot;</strong>",
    "fallback-install-btn": "📦 Install CodeKey Extension",
    "fallback-qq": "QQ Group",
    "fallback-email": "Email",
  },
};
let currentLang = 'en';
function applyLang(lang) {
  currentLang = lang;
  const dict = i18n[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (dict[key] !== undefined) el.innerHTML = dict[key];
  });
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}
function toggleLang() { applyLang(currentLang === 'en' ? 'zh' : 'en'); }
const browserLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
applyLang(browserLang.startsWith('zh') ? 'zh' : 'en');
</script>
</body>
</html>`;
}
