// Legal pages required by PayPal merchant review:
// Privacy Policy, Refund Policy, Terms of Service, Contact Us.
//
// Each page is rendered with both English and Chinese bodies in
// the HTML (English visible by default to satisfy PayPal's English
// crawler; Chinese shown when the user toggles language).
//
// All merchant-identifying strings come from environment variables
// so the same code base works whether the operator is a sole
// proprietor, registered company, or individual PayPal account.

import type { Env } from "./shared";
import { commonStyles, escapeHtml, renderFooter, renderTopNav } from "./shared";
import { i18nScript } from "./i18n";

interface ShellOpts {
	active: string;
	titleEn: string;
	titleZh: string;
	bodyEn: string;
	bodyZh: string;
}

function renderPolicyShell(env: Env, opts: ShellOpts): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.titleEn)} &mdash; CodeKey</title>
<style>
${commonStyles()}
</style>
</head>
<body>
<div class="container policy-page">
  <div class="lang-bar">
    <button class="lang-btn" id="langToggle" onclick="toggleLang()">\ud83c\udde8\ud83c\uddf3 \u4e2d\u6587</button>
  </div>

  ${renderTopNav(opts.active)}

  <h1 id="policy-title">${escapeHtml(opts.titleEn)}</h1>
  <p class="policy-meta"><span data-i18n="policy-effective">Effective Date</span>: ${escapeHtml(env.EFFECTIVE_DATE)}</p>

  <div id="policy-body-en">${opts.bodyEn}</div>
  <div id="policy-body-zh" style="display:none">${opts.bodyZh}</div>
</div>

${renderFooter(env)}

${i18nScript(env)}
<script>
const POLICY_TITLE_EN = ${JSON.stringify(opts.titleEn)};
const POLICY_TITLE_ZH = ${JSON.stringify(opts.titleZh)};

function onLangChange(lang) {
  const titleEl = document.getElementById('policy-title');
  if (titleEl) titleEl.textContent = lang === 'zh' ? POLICY_TITLE_ZH : POLICY_TITLE_EN;
  document.getElementById('policy-body-en').style.display = lang === 'zh' ? 'none' : 'block';
  document.getElementById('policy-body-zh').style.display = lang === 'zh' ? 'block' : 'none';
  document.title = (lang === 'zh' ? POLICY_TITLE_ZH : POLICY_TITLE_EN) + ' \u2014 CodeKey';
}
onLangChange(currentLang);
</script>
</body>
</html>`;
}

// ── Privacy Policy ─────────────────────────────────────────

export function renderPrivacyPage(env: Env): string {
	const merchantEn = escapeHtml(env.MERCHANT_NAME);
	const merchantZh = escapeHtml(env.MERCHANT_NAME_CN || env.MERCHANT_NAME);
	const addrEn = escapeHtml(env.MERCHANT_ADDRESS);
	const addrZh = escapeHtml(env.MERCHANT_ADDRESS_CN || env.MERCHANT_ADDRESS);
	const email = escapeHtml(env.SUPPORT_EMAIL);
	const phone = escapeHtml(env.SUPPORT_PHONE);

	const bodyEn = `
<p>This Privacy Policy explains how <strong>${merchantEn}</strong> ("we", "us", "our") operating <strong>CodeKey</strong> (the "Service") collects, uses, stores, and shares information when you use our website, VS Code extension, or mobile companion app.</p>

<h2>1. Information We Collect</h2>
<ul>
  <li><strong>Account information:</strong> email address (when you contact support), Telegram or WeChat user ID (for device pairing).</li>
  <li><strong>Payment information:</strong> processed entirely by PayPal or our China payment partner. We do not see or store credit card numbers, CVVs, or bank account details. We receive only the transaction ID, amount, plan name, and approval status.</li>
  <li><strong>Device pairing data:</strong> a randomly generated device ID, a public encryption key, and a non-personal device label.</li>
  <li><strong>Usage data:</strong> approval counts, session timestamps, and error logs. AI agent prompts and command bodies are end-to-end encrypted; we cannot read them.</li>
  <li><strong>Cookies:</strong> we use a single session cookie for authentication. We do not use third-party advertising or tracking cookies.</li>
</ul>

<h2>2. How We Use Your Information</h2>
<ul>
  <li>Operate the subscription service, deliver approval notifications, enforce plan quotas.</li>
  <li>Process payments and issue refunds where applicable (see <a href="/refund">Refund Policy</a>).</li>
  <li>Respond to your customer support requests.</li>
  <li>Detect abuse, fraud, and unauthorized access.</li>
  <li>Comply with legal obligations.</li>
</ul>

<h2>3. Third-Party Sharing</h2>
<p>We share the minimum necessary data with the following processors:</p>
<ul>
  <li><strong>PayPal Holdings, Inc.</strong> &mdash; international payment processing.</li>
  <li><strong>Cloudflare, Inc.</strong> &mdash; CDN, DDoS protection, edge compute.</li>
  <li><strong>Telegram Messenger Inc.</strong> / <strong>Tencent (WeChat)</strong> &mdash; only the user IDs needed to deliver notifications you initiated.</li>
</ul>
<p>We never sell your data. We never share with advertisers.</p>

<h2>4. Data Storage and Retention</h2>
<p>Data is stored on Cloudflare and on servers located in the regions where you operate. Subscription records are kept while your account is active and for up to 24 months after cancellation for tax and audit purposes. You may request deletion at any time.</p>

<h2>5. Data Security</h2>
<p>All website traffic is HTTPS/TLS 1.3 encrypted. AI prompt content and approval payloads use end-to-end encryption between your desktop and phone &mdash; our servers act only as an encrypted relay and cannot decrypt them.</p>

<h2>6. Your Rights</h2>
<p>You may request to access, correct, export, or delete your personal data, or restrict its processing, at any time by emailing <a href="mailto:${email}">${email}</a>. We will respond within 30 days.</p>

<h2>7. Children's Privacy</h2>
<p>The Service is not intended for users under 16 years of age. We do not knowingly collect data from children.</p>

<h2>8. International Transfers</h2>
<p>If you access the Service from outside the country where our servers are located, your information may be transferred internationally. We rely on standard contractual clauses or equivalent safeguards.</p>

<h2>9. Changes to this Policy</h2>
<p>We may update this Privacy Policy. The "Effective Date" at the top reflects the latest version. Material changes will be announced on this page.</p>

<h2>10. Contact</h2>
<p>${merchantEn}<br>
${addrEn}<br>
Email: <a href="mailto:${email}">${email}</a><br>
Phone: ${phone}</p>
`;

	const bodyZh = `
<p>\u672c\u9690\u79c1\u653f\u7b56\u8bf4\u660e <strong>${merchantZh}</strong>\uff08\u201c\u6211\u4eec\u201d\uff09\u8fd0\u8425 <strong>CodeKey</strong>\uff08\u201c\u672c\u670d\u52a1\u201d\uff09\u65f6\uff0c\u5982\u4f55\u6536\u96c6\u3001\u4f7f\u7528\u3001\u5b58\u50a8\u548c\u5171\u4eab\u60a8\u7684\u4fe1\u606f\u3002</p>

<h2>1. \u6211\u4eec\u6536\u96c6\u7684\u4fe1\u606f</h2>
<ul>
  <li><strong>\u8d26\u53f7\u4fe1\u606f\uff1a</strong>\u90ae\u7bb1\u5730\u5740\uff08\u8054\u7cfb\u5ba2\u670d\u65f6\uff09\u3001Telegram \u6216\u5fae\u4fe1\u7528\u6237 ID\uff08\u7528\u4e8e\u8bbe\u5907\u914d\u5bf9\uff09\u3002</li>
  <li><strong>\u652f\u4ed8\u4fe1\u606f\uff1a</strong>\u5168\u90e8\u7531 PayPal \u6216\u56fd\u5185\u652f\u4ed8\u5408\u4f5c\u65b9\u5904\u7406\u3002\u6211\u4eec\u4e0d\u770b\u4e0d\u5b58\u50a8\u4fe1\u7528\u5361\u53f7\u3001CVV \u6216\u94f6\u884c\u8d26\u6237\u4fe1\u606f\uff0c\u4ec5\u63a5\u6536\u4ea4\u6613\u53f7\u3001\u91d1\u989d\u3001\u65b9\u6848\u540d\u79f0\u548c\u652f\u4ed8\u72b6\u6001\u3002</li>
  <li><strong>\u8bbe\u5907\u914d\u5bf9\u6570\u636e\uff1a</strong>\u968f\u673a\u751f\u6210\u7684\u8bbe\u5907 ID\u3001\u516c\u5f00\u52a0\u5bc6\u5bc6\u94a5\u3001\u8bbe\u5907\u6807\u7b7e\u3002</li>
  <li><strong>\u4f7f\u7528\u6570\u636e\uff1a</strong>\u5ba1\u6279\u8ba1\u6570\u3001\u4f1a\u8bdd\u65f6\u95f4\u6233\u3001\u9519\u8bef\u65e5\u5fd7\u3002AI \u4ee3\u7406\u63d0\u793a\u8bcd\u548c\u547d\u4ee4\u5185\u5bb9\u4f7f\u7528\u7aef\u5230\u7aef\u52a0\u5bc6\uff0c\u6211\u4eec\u65e0\u6cd5\u8bfb\u53d6\u3002</li>
  <li><strong>Cookie\uff1a</strong>\u4ec5\u4f7f\u7528\u4e00\u4e2a\u4f1a\u8bdd Cookie \u7528\u4e8e\u8eab\u4efd\u9a8c\u8bc1\uff0c\u4e0d\u4f7f\u7528\u7b2c\u4e09\u65b9\u5e7f\u544a\u6216\u8ddf\u8e2a Cookie\u3002</li>
</ul>

<h2>2. \u4fe1\u606f\u7684\u4f7f\u7528</h2>
<ul>
  <li>\u8fd0\u8425\u8ba2\u9605\u670d\u52a1\u3001\u63a8\u9001\u5ba1\u6279\u901a\u77e5\u3001\u6267\u884c\u989d\u5ea6\u9650\u5236\u3002</li>
  <li>\u5904\u7406\u652f\u4ed8\u53ca\u9000\u6b3e\uff08\u53c2\u89c1<a href="/refund">\u9000\u6b3e\u653f\u7b56</a>\uff09\u3002</li>
  <li>\u54cd\u5e94\u60a8\u7684\u5ba2\u670d\u8bf7\u6c42\u3002</li>
  <li>\u68c0\u6d4b\u6ee5\u7528\u3001\u6b3a\u8bc8\u3001\u672a\u6388\u6743\u8bbf\u95ee\u3002</li>
  <li>\u5c65\u884c\u6cd5\u5f8b\u4e49\u52a1\u3002</li>
</ul>

<h2>3. \u7b2c\u4e09\u65b9\u5171\u4eab</h2>
<p>\u6211\u4eec\u4ec5\u5411\u4e0b\u5217\u5904\u7406\u8005\u5171\u4eab\u5fc5\u8981\u7684\u6700\u5c11\u6570\u636e\uff1a</p>
<ul>
  <li><strong>PayPal Holdings, Inc.</strong> \u2014 \u56fd\u9645\u652f\u4ed8\u5904\u7406\u3002</li>
  <li><strong>Cloudflare, Inc.</strong> \u2014 CDN\u3001\u9632 DDoS\u3001\u8fb9\u7f18\u8ba1\u7b97\u3002</li>
  <li><strong>Telegram Messenger Inc.</strong> / <strong>\u817e\u8baf\uff08\u5fae\u4fe1\uff09</strong> \u2014 \u4ec5\u4e3a\u63a8\u9001\u60a8\u53d1\u8d77\u7684\u901a\u77e5\u6240\u9700\u7684\u7528\u6237 ID\u3002</li>
</ul>
<p>\u6211\u4eec\u7edd\u4e0d\u51fa\u552e\u60a8\u7684\u6570\u636e\uff0c\u7edd\u4e0d\u4e0e\u5e7f\u544a\u5546\u5171\u4eab\u3002</p>

<h2>4. \u6570\u636e\u5b58\u50a8\u4e0e\u4fdd\u7559</h2>
<p>\u6570\u636e\u5b58\u50a8\u4e8e Cloudflare \u53ca\u670d\u52a1\u5668\u3002\u8ba2\u9605\u8bb0\u5f55\u5728\u8d26\u6237\u6709\u6548\u671f\u95f4\u4fdd\u5b58\uff0c\u6ce8\u9500\u540e\u51fa\u4e8e\u7a0e\u52a1\u4e0e\u5ba1\u8ba1\u4fdd\u7559\u6700\u591a 24 \u4e2a\u6708\u3002\u60a8\u53ef\u968f\u65f6\u8981\u6c42\u5220\u9664\u3002</p>

<h2>5. \u6570\u636e\u5b89\u5168</h2>
<p>\u6240\u6709\u7f51\u7ad9\u6d41\u91cf\u4f7f\u7528 HTTPS/TLS 1.3 \u52a0\u5bc6\u3002AI \u63d0\u793a\u8bcd\u548c\u5ba1\u6279\u8d1f\u8f7d\u5728\u684c\u9762\u4e0e\u624b\u673a\u95f4\u91c7\u7528\u7aef\u5230\u7aef\u52a0\u5bc6\uff0c\u6211\u4eec\u670d\u52a1\u5668\u4ec5\u4f5c\u4e3a\u52a0\u5bc6\u4e2d\u7ee7\uff0c\u65e0\u6cd5\u89e3\u5bc6\u3002</p>

<h2>6. \u60a8\u7684\u6743\u5229</h2>
<p>\u60a8\u53ef\u968f\u65f6\u53d1\u90ae\u4ef6\u81f3 <a href="mailto:${email}">${email}</a> \u8bf7\u6c42\u8bbf\u95ee\u3001\u66f4\u6b63\u3001\u5bfc\u51fa\u3001\u5220\u9664\u4e2a\u4eba\u6570\u636e\u6216\u9650\u5236\u5176\u5904\u7406\uff0c\u6211\u4eec\u5c06\u5728 30 \u5929\u5185\u54cd\u5e94\u3002</p>

<h2>7. \u672a\u6210\u5e74\u4eba\u9690\u79c1</h2>
<p>\u672c\u670d\u52a1\u4e0d\u9762\u5411 16 \u5468\u5c81\u4ee5\u4e0b\u7528\u6237\uff0c\u6211\u4eec\u4e0d\u4f1a\u4e3b\u52a8\u6536\u96c6\u672a\u6210\u5e74\u4eba\u4fe1\u606f\u3002</p>

<h2>8. \u8de8\u5883\u4f20\u8f93</h2>
<p>\u82e5\u60a8\u5728\u670d\u52a1\u5668\u6240\u5728\u56fd\u5916\u4f7f\u7528\u672c\u670d\u52a1\uff0c\u60a8\u7684\u4fe1\u606f\u53ef\u80fd\u4f1a\u88ab\u8de8\u5883\u4f20\u8f93\uff0c\u6211\u4eec\u9075\u5faa\u6807\u51c6\u5408\u540c\u6761\u6b3e\u6216\u540c\u7b49\u4fdd\u62a4\u63aa\u65bd\u3002</p>

<h2>9. \u672c\u653f\u7b56\u7684\u53d8\u66f4</h2>
<p>\u6211\u4eec\u53ef\u80fd\u66f4\u65b0\u672c\u9690\u79c1\u653f\u7b56\uff0c\u9876\u90e8\u201c\u751f\u6548\u65e5\u671f\u201d\u53cd\u6620\u6700\u65b0\u7248\u672c\uff0c\u91cd\u5927\u53d8\u66f4\u5c06\u5728\u672c\u9875\u9762\u516c\u544a\u3002</p>

<h2>10. \u8054\u7cfb\u65b9\u5f0f</h2>
<p>${merchantZh}<br>
${addrZh}<br>
\u90ae\u7bb1\uff1a<a href="mailto:${email}">${email}</a><br>
\u7535\u8bdd\uff1a${phone}</p>
`;

	return renderPolicyShell(env, {
		active: "privacy",
		titleEn: "Privacy Policy",
		titleZh: "\u9690\u79c1\u653f\u7b56",
		bodyEn,
		bodyZh,
	});
}

// ── Refund & Return Policy ────────────────────────────────

export function renderRefundPage(env: Env): string {
	const merchantEn = escapeHtml(env.MERCHANT_NAME);
	const merchantZh = escapeHtml(env.MERCHANT_NAME_CN || env.MERCHANT_NAME);
	const addrEn = escapeHtml(env.MERCHANT_ADDRESS);
	const addrZh = escapeHtml(env.MERCHANT_ADDRESS_CN || env.MERCHANT_ADDRESS);
	const email = escapeHtml(env.SUPPORT_EMAIL);
	const phone = escapeHtml(env.SUPPORT_PHONE);

	const bodyEn = `
<p>This Refund Policy applies to all subscriptions to <strong>CodeKey Pro</strong> sold by <strong>${merchantEn}</strong>.</p>

<h2>1. Nature of the Product</h2>
<p>CodeKey Pro is a <strong>digital subscription service</strong>. There is no physical product. There is nothing to ship and nothing to return.</p>

<h2>2. 14-Day Free Trial</h2>
<p>Every new user automatically receives a <strong>14-day free trial</strong> of Pro features. The trial is charge-free; no payment is collected during the trial period. You may cancel at any time during the trial without paying anything.</p>

<h2>3. Post-Trial Subscriptions Are Non-Refundable</h2>
<p>By subscribing after the 14-day free trial, you acknowledge and agree that:</p>
<ul>
  <li>Subscription fees (monthly or yearly) are <strong>non-refundable</strong> once the billing period has started.</li>
  <li>Cancellation stops future renewals but does <strong>not</strong> refund the current period; you keep Pro access until the period ends.</li>
  <li>Partial periods, unused approvals, and unused days are not refunded.</li>
</ul>
<p>This policy exists because we provide unlimited usage immediately on payment, the cost of which we cannot recover after delivery.</p>

<h2>4. Exceptions Where Refunds Will Be Issued</h2>
<p>We will issue a full refund within 14 calendar days of payment if any of the following apply:</p>
<ul>
  <li><strong>Duplicate charge</strong> &mdash; you were billed twice for the same period.</li>
  <li><strong>Unauthorized charge</strong> &mdash; the payment was made without your authorization (please also contact your card issuer).</li>
  <li><strong>Service unavailable</strong> &mdash; the Service was unavailable for more than 72 consecutive hours due to our fault and we could not restore your access.</li>
  <li><strong>Material misrepresentation</strong> &mdash; a feature you specifically subscribed for was removed during your billing period without an equivalent replacement.</li>
</ul>

<h2>5. How to Cancel</h2>
<ul>
  <li><strong>PayPal subscribers:</strong> log in to PayPal &rarr; Settings &rarr; Payments &rarr; Manage automatic payments &rarr; CodeKey &rarr; Cancel. You may also email us and we will process the cancellation.</li>
  <li><strong>China redeem-code users:</strong> redeem codes are pay-as-you-go; there is nothing to cancel. Unused codes can be refunded if requested within 7 days of purchase and have not been activated.</li>
</ul>

<h2>6. How to Request a Refund</h2>
<p>Email <a href="mailto:${email}">${email}</a> with:</p>
<ul>
  <li>Your PayPal transaction ID or redeem code.</li>
  <li>Your registered email or Telegram/WeChat ID.</li>
  <li>The reason for your request.</li>
</ul>
<p>We respond within <strong>1 business day</strong>. Approved refunds are processed back to the original payment method within <strong>5&ndash;10 business days</strong>.</p>

<h2>7. Disputes</h2>
<p>Before opening a PayPal dispute or chargeback, please contact us first. We will work with you in good faith to resolve any billing issue.</p>

<h2>8. Contact</h2>
<p>${merchantEn}<br>
${addrEn}<br>
Email: <a href="mailto:${email}">${email}</a><br>
Phone: ${phone}</p>
`;

	const bodyZh = `
<p>\u672c\u9000\u6b3e\u653f\u7b56\u9002\u7528\u4e8e <strong>${merchantZh}</strong> \u9500\u552e\u7684\u6240\u6709 <strong>CodeKey Pro</strong> \u8ba2\u9605\u3002</p>

<h2>1. \u4ea7\u54c1\u6027\u8d28</h2>
<p>CodeKey Pro \u662f\u4e00\u9879<strong>\u865a\u62df\u8ba2\u9605\u670d\u52a1</strong>\uff0c\u65e0\u5b9e\u4f53\u5546\u54c1\uff0c\u65e0\u9700\u53d1\u8d27\u53ca\u9000\u8d27\u3002</p>

<h2>2. 14 \u5929\u514d\u8d39\u8bd5\u7528</h2>
<p>\u6240\u6709\u65b0\u7528\u6237\u81ea\u52a8\u83b7\u5f97 <strong>14 \u5929\u514d\u8d39\u8bd5\u7528</strong>\u3002\u8bd5\u7528\u671f\u95f4\u4e0d\u4ea7\u751f\u4efb\u4f55\u8d39\u7528\uff0c\u968f\u65f6\u53ef\u4ee5\u53d6\u6d88\u4e0d\u4ea7\u751f\u8d39\u7528\u3002</p>

<h2>3. \u8bd5\u7528\u671f\u540e\u7684\u8ba2\u9605\u4e0d\u9000\u6b3e</h2>
<p>14 \u5929\u8bd5\u7528\u671f\u7ed3\u675f\u540e\u8ba2\u9605\uff0c\u5373\u8868\u793a\u60a8\u77e5\u6089\u5e76\u540c\u610f\uff1a</p>
<ul>
  <li>\u8ba2\u9605\u8d39\u7528\uff08\u6708\u4ed8\u6216\u5e74\u4ed8\uff09\u4e00\u65e6\u8ba1\u8d39\u5468\u671f\u5f00\u59cb\u5373<strong>\u4e0d\u4e88\u9000\u6b3e</strong>\u3002</li>
  <li>\u53d6\u6d88\u8ba2\u9605\u4ec5\u505c\u6b62\u4e0b\u4e00\u5468\u671f\u7eed\u8d39\uff0c<strong>\u4e0d\u9000</strong>\u5f53\u524d\u5468\u671f\u8d39\u7528\uff0c\u60a8\u4ecd\u53ef\u4f7f\u7528\u81f3\u5468\u671f\u7ed3\u675f\u3002</li>
  <li>\u90e8\u5206\u5468\u671f\u3001\u672a\u4f7f\u7528\u989d\u5ea6\u3001\u672a\u4f7f\u7528\u5929\u6570\u4e0d\u4e88\u9000\u6b3e\u3002</li>
</ul>
<p>\u672c\u653f\u7b56\u7531\u4e8e\u8ba2\u9605\u751f\u6548\u540e\u7acb\u5373\u63d0\u4f9b\u65e0\u9650\u4f7f\u7528\u6743\u9650\uff0c\u670d\u52a1\u4ea4\u4ed8\u540e\u4e0d\u53ef\u9000\u8fd8\u3002</p>

<h2>4. \u53ef\u9000\u6b3e\u7684\u4f8b\u5916\u60c5\u5f62</h2>
<p>\u4ee5\u4e0b\u60c5\u5f62\u6211\u4eec\u5c06\u5728\u4ed8\u6b3e\u540e 14 \u4e2a\u81ea\u7136\u65e5\u5185\u5168\u989d\u9000\u6b3e\uff1a</p>
<ul>
  <li><strong>\u91cd\u590d\u6263\u8d39</strong> \u2014 \u540c\u4e00\u5468\u671f\u91cd\u590d\u6263\u6b3e\u3002</li>
  <li><strong>\u672a\u6388\u6743\u4ed8\u6b3e</strong> \u2014 \u672a\u7ecf\u60a8\u672c\u4eba\u6388\u6743\u7684\u4ed8\u6b3e\uff08\u8bf7\u540c\u65f6\u8054\u7cfb\u53d1\u5361\u884c\uff09\u3002</li>
  <li><strong>\u670d\u52a1\u4e0d\u53ef\u7528</strong> \u2014 \u56e0\u6211\u65b9\u8fc7\u9519\u5bfc\u81f4\u670d\u52a1\u8fde\u7eed\u4e0d\u53ef\u7528\u8d85\u8fc7 72 \u5c0f\u65f6\u3002</li>
  <li><strong>\u91cd\u5927\u8bef\u5bfc</strong> \u2014 \u60a8\u7279\u522b\u4e3a\u67d0\u9879\u529f\u80fd\u8ba2\u9605\uff0c\u4f46\u8be5\u529f\u80fd\u5728\u5468\u671f\u5185\u88ab\u79fb\u9664\u4e14\u65e0\u7b49\u540c\u66ff\u4ee3\u3002</li>
</ul>

<h2>5. \u5982\u4f55\u53d6\u6d88</h2>
<ul>
  <li><strong>PayPal \u8ba2\u9605\u7528\u6237\uff1a</strong>\u767b\u5f55 PayPal \u2192 \u8bbe\u7f6e \u2192 \u4ed8\u6b3e \u2192 \u7ba1\u7406\u81ea\u52a8\u4ed8\u6b3e \u2192 CodeKey \u2192 \u53d6\u6d88\u3002\u4e5f\u53ef\u53d1\u90ae\u4ef6\u4e0e\u6211\u4eec\u8054\u7cfb\u4ee3\u4e3a\u53d6\u6d88\u3002</li>
  <li><strong>\u5151\u6362\u7801\u7528\u6237\uff1a</strong>\u5151\u6362\u7801\u4e3a\u4e00\u6b21\u6027\u8d2d\u4e70\uff0c\u65e0\u9700\u53d6\u6d88\u3002\u672a\u6fc0\u6d3b\u7684\u5151\u6362\u7801\u53ef\u5728\u8d2d\u4e70\u540e 7 \u5929\u5185\u7533\u8bf7\u9000\u6b3e\u3002</li>
</ul>

<h2>6. \u5982\u4f55\u7533\u8bf7\u9000\u6b3e</h2>
<p>\u53d1\u9001\u90ae\u4ef6\u81f3 <a href="mailto:${email}">${email}</a>\uff0c\u9644\u4ee5\u4e0b\u4fe1\u606f\uff1a</p>
<ul>
  <li>PayPal \u4ea4\u6613\u53f7\u6216\u5151\u6362\u7801\u3002</li>
  <li>\u8d26\u6237\u90ae\u7bb1\u6216 Telegram / \u5fae\u4fe1 ID\u3002</li>
  <li>\u9000\u6b3e\u539f\u56e0\u3002</li>
</ul>
<p>\u6211\u4eec\u5728<strong>\u5de5\u4f5c\u65e5 24 \u5c0f\u65f6\u5185</strong>\u54cd\u5e94\u3002\u5ba1\u6838\u901a\u8fc7\u540e\u9000\u6b3e\u5c06\u5728 <strong>5\u201310 \u4e2a\u5de5\u4f5c\u65e5</strong>\u5185\u9000\u56de\u539f\u4ed8\u6b3e\u8d26\u6237\u3002</p>

<h2>7. \u4e89\u8bae\u5904\u7406</h2>
<p>\u53d1\u8d77 PayPal Dispute \u6216\u4fe1\u7528\u5361 chargeback \u524d\uff0c\u8bf7\u5148\u8054\u7cfb\u6211\u4eec\uff0c\u6211\u4eec\u5c06\u4ee5\u8bda\u4fe1\u539f\u5219\u534f\u52a9\u89e3\u51b3\u4efb\u4f55\u8ba1\u8d39\u95ee\u9898\u3002</p>

<h2>8. \u8054\u7cfb\u65b9\u5f0f</h2>
<p>${merchantZh}<br>
${addrZh}<br>
\u90ae\u7bb1\uff1a<a href="mailto:${email}">${email}</a><br>
\u7535\u8bdd\uff1a${phone}</p>
`;

	return renderPolicyShell(env, {
		active: "refund",
		titleEn: "Refund & Return Policy",
		titleZh: "\u9000\u6b3e\u653f\u7b56",
		bodyEn,
		bodyZh,
	});
}

// ── Terms of Service ──────────────────────────────────────

export function renderTermsPage(env: Env): string {
	const merchantEn = escapeHtml(env.MERCHANT_NAME);
	const merchantZh = escapeHtml(env.MERCHANT_NAME_CN || env.MERCHANT_NAME);
	const addrEn = escapeHtml(env.MERCHANT_ADDRESS);
	const addrZh = escapeHtml(env.MERCHANT_ADDRESS_CN || env.MERCHANT_ADDRESS);
	const email = escapeHtml(env.SUPPORT_EMAIL);
	const phone = escapeHtml(env.SUPPORT_PHONE);

	const bodyEn = `
<p>These Terms of Service ("Terms") govern your access to and use of <strong>CodeKey</strong> (the "Service") provided by <strong>${merchantEn}</strong>. By using the Service or creating an account, you agree to these Terms.</p>

<h2>1. The Service</h2>
<p>CodeKey is a developer tool that lets you remotely review and approve AI agent actions executing in your VS Code editor from a phone or chat client (Telegram, WeChat). Free and Pro tiers are offered. Features and limits of each tier are listed on the <a href="/">home page</a>.</p>

<h2>2. Account &amp; Eligibility</h2>
<ul>
  <li>You must be at least 16 years old to use the Service.</li>
  <li>You must provide accurate registration information and keep it up to date.</li>
  <li>You are responsible for safeguarding your device pairing codes and account credentials.</li>
</ul>

<h2>3. Subscription, Billing, and Renewal</h2>
<ul>
  <li>Pro plans are sold as monthly or yearly subscriptions in USD via PayPal, or via redeem codes purchased in CNY for China users.</li>
  <li>Subscriptions <strong>auto-renew</strong> at the end of each period unless cancelled. The renewal price equals the price at the time of purchase unless we notify you of a change at least 30 days in advance.</li>
  <li>You authorize us (via PayPal) to charge your payment method on each renewal.</li>
  <li>All prices and fees are clearly displayed before checkout. We do not charge hidden fees or surcharges for choosing PayPal.</li>
</ul>

<h2>4. Cancellation and Refunds</h2>
<p>You may cancel anytime. Cancellation stops future renewals but does not refund the current period. Refund eligibility is described in our <a href="/refund">Refund Policy</a>.</p>

<h2>5. Acceptable Use</h2>
<p>You agree not to:</p>
<ul>
  <li>Use the Service for any illegal purpose or in violation of any applicable laws.</li>
  <li>Resell, sublicense, or redistribute the Service or any redeem codes outside their intended use.</li>
  <li>Reverse engineer, decompile, or attempt to extract the source code of our software, except where permitted by law.</li>
  <li>Interfere with, disrupt, or attempt to gain unauthorized access to our servers or other users' accounts.</li>
  <li>Use the Service to transmit malware, spam, or content that infringes third-party rights.</li>
</ul>
<p>We may suspend or terminate accounts that violate these rules, with refund issued only where required by our <a href="/refund">Refund Policy</a>.</p>

<h2>6. Intellectual Property</h2>
<p>The Service, including all software, design, text, and trademarks, is owned by ${merchantEn} or its licensors. We grant you a limited, non-exclusive, non-transferable license to use the Service for your personal or internal business purposes during your active subscription.</p>

<h2>7. User Content</h2>
<p>You retain ownership of any prompts, code, or other content you submit through the Service. Because content is end-to-end encrypted between your devices, we do not access it. You are solely responsible for the content you transmit.</p>

<h2>8. Disclaimers</h2>
<p>The Service is provided <strong>"AS IS"</strong> and <strong>"AS AVAILABLE"</strong>. To the maximum extent permitted by law, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose, and non-infringement. We do not warrant that the Service will be uninterrupted, error-free, or secure.</p>

<h2>9. Limitation of Liability</h2>
<p>To the maximum extent permitted by law, our total liability to you for any claim arising out of these Terms or the Service shall not exceed the amount you paid us in the 12 months preceding the claim. We are not liable for indirect, incidental, special, consequential, or punitive damages.</p>

<h2>10. Indemnification</h2>
<p>You agree to indemnify and hold ${merchantEn} harmless from any claim arising out of your misuse of the Service or violation of these Terms.</p>

<h2>11. Changes to the Service or Terms</h2>
<p>We may modify the Service or these Terms. Material changes will be announced on this page and, where reasonable, by email. Continued use of the Service after the effective date constitutes acceptance.</p>

<h2>12. Termination</h2>
<p>You may terminate your account at any time. We may suspend or terminate your access for breach of these Terms or for fraud, with notice where reasonable.</p>

<h2>13. Governing Law and Disputes</h2>
<p>These Terms are governed by the laws of the People's Republic of China, without regard to its conflict-of-law rules. Any dispute will first be addressed through good-faith negotiation. If unresolved, disputes shall be submitted to the competent court at the location of ${merchantEn}'s registered address.</p>

<h2>14. Contact</h2>
<p>${merchantEn}<br>
${addrEn}<br>
Email: <a href="mailto:${email}">${email}</a><br>
Phone: ${phone}</p>
`;

	const bodyZh = `
<p>\u672c\u300a\u670d\u52a1\u6761\u6b3e\u300b\uff08\u201c\u672c\u6761\u6b3e\u201d\uff09\u9002\u7528\u4e8e\u60a8\u4f7f\u7528 <strong>${merchantZh}</strong> \u63d0\u4f9b\u7684 <strong>CodeKey</strong>\uff08\u201c\u672c\u670d\u52a1\u201d\uff09\u3002\u4f7f\u7528\u672c\u670d\u52a1\u6216\u521b\u5efa\u8d26\u53f7\u5373\u8868\u793a\u60a8\u540c\u610f\u672c\u6761\u6b3e\u3002</p>

<h2>1. \u670d\u52a1\u8bf4\u660e</h2>
<p>CodeKey \u662f\u4e00\u6b3e\u5f00\u53d1\u8005\u5de5\u5177\uff0c\u8ba9\u60a8\u80fd\u591f\u4ece\u624b\u673a\u6216\u804a\u5929\u5e94\u7528\uff08Telegram\u3001\u5fae\u4fe1\uff09\u8fdc\u7a0b\u5ba1\u6279 VS Code \u4e2d AI \u4ee3\u7406\u7684\u52a8\u4f5c\u3002\u5404\u7b49\u7ea7\u7684\u529f\u80fd\u4e0e\u9650\u5236\u8bf7\u53c2\u89c1<a href="/">\u9996\u9875</a>\u3002</p>

<h2>2. \u8d26\u6237\u4e0e\u4f7f\u7528\u8d44\u683c</h2>
<ul>
  <li>\u4f7f\u7528\u672c\u670d\u52a1\u9700\u5e74\u6ee1 16 \u5468\u5c81\u3002</li>
  <li>\u60a8\u987b\u63d0\u4f9b\u51c6\u786e\u7684\u6ce8\u518c\u4fe1\u606f\u5e76\u4fdd\u6301\u66f4\u65b0\u3002</li>
  <li>\u60a8\u8d1f\u8d23\u59a5\u5584\u4fdd\u7ba1\u8bbe\u5907\u914d\u5bf9\u7801\u53ca\u8d26\u6237\u51ed\u8bc1\u3002</li>
</ul>

<h2>3. \u8ba2\u9605\u3001\u8ba1\u8d39\u4e0e\u7eed\u8d39</h2>
<ul>
  <li>Pro \u65b9\u6848\u4ee5\u7f8e\u5143\u8ba1\u4ef7\u901a\u8fc7 PayPal \u9500\u552e\u6708\u4ed8/\u5e74\u4ed8\u8ba2\u9605\uff0c\u56fd\u5185\u7528\u6237\u53ef\u901a\u8fc7\u4eba\u6c11\u5e01\u8d2d\u4e70\u5151\u6362\u7801\u3002</li>
  <li>\u8ba2\u9605\u5728\u6bcf\u4e2a\u5468\u671f\u7ed3\u675f\u65f6<strong>\u81ea\u52a8\u7eed\u8d39</strong>\uff0c\u9664\u975e\u53d6\u6d88\u3002\u7eed\u8d39\u4ef7\u683c\u4e0e\u9996\u6b21\u8d2d\u4e70\u4ef7\u4e00\u81f4\uff0c\u8c03\u4ef7\u4f1a\u63d0\u524d 30 \u5929\u544a\u77e5\u3002</li>
  <li>\u60a8\u6388\u6743\u6211\u4eec\uff08\u901a\u8fc7 PayPal\uff09\u5728\u6bcf\u6b21\u7eed\u8d39\u65f6\u4ece\u60a8\u7684\u4ed8\u6b3e\u65b9\u5f0f\u6263\u6b3e\u3002</li>
  <li>\u6240\u6709\u4ef7\u683c\u4e0e\u8d39\u7528\u4e8e\u7ed3\u7b97\u524d\u660e\u793a\uff0c\u6211\u4eec\u4e0d\u4f1a\u9690\u85cf\u6536\u8d39\uff0c\u4e0d\u5bf9 PayPal \u9009\u62e9\u52a0\u6536\u9644\u52a0\u8d39\u3002</li>
</ul>

<h2>4. \u53d6\u6d88\u4e0e\u9000\u6b3e</h2>
<p>\u60a8\u53ef\u968f\u65f6\u53d6\u6d88\u3002\u53d6\u6d88\u4ec5\u505c\u6b62\u4e0b\u4e00\u5468\u671f\u7eed\u8d39\uff0c\u4e0d\u9000\u8fd8\u5f53\u524d\u5468\u671f\u8d39\u7528\u3002\u9000\u6b3e\u8d44\u683c\u8be6\u89c1<a href="/refund">\u9000\u6b3e\u653f\u7b56</a>\u3002</p>

<h2>5. \u4f7f\u7528\u89c4\u8303</h2>
<p>\u60a8\u540c\u610f\u4e0d\u5f97\uff1a</p>
<ul>
  <li>\u5c06\u672c\u670d\u52a1\u7528\u4e8e\u4efb\u4f55\u975e\u6cd5\u76ee\u7684\u6216\u8fdd\u53cd\u9002\u7528\u6cd5\u5f8b\u3002</li>
  <li>\u8f6c\u552e\u3001\u8f6c\u8bb8\u53ef\u6216\u91cd\u65b0\u5206\u53d1\u672c\u670d\u52a1\u6216\u5151\u6362\u7801\u3002</li>
  <li>\u9006\u5411\u5de5\u7a0b\u3001\u53cd\u7f16\u8bd1\u6216\u63d0\u53d6\u8f6f\u4ef6\u6e90\u4ee3\u7801\uff08\u6cd5\u5f8b\u5141\u8bb8\u9664\u5916\uff09\u3002</li>
  <li>\u5e72\u6270\u3001\u7834\u574f\u670d\u52a1\u5668\u6216\u672a\u7ecf\u6388\u6743\u8bbf\u95ee\u4ed6\u4eba\u8d26\u6237\u3002</li>
  <li>\u4f20\u8f93\u6076\u610f\u8f6f\u4ef6\u3001\u5783\u573e\u4fe1\u606f\u6216\u4fb5\u5bb3\u7b2c\u4e09\u65b9\u6743\u5229\u7684\u5185\u5bb9\u3002</li>
</ul>
<p>\u6211\u4eec\u53ef\u80fd\u6682\u505c\u6216\u7ec8\u6b62\u8fdd\u53cd\u4e0a\u8ff0\u89c4\u5219\u7684\u8d26\u6237\uff0c\u4ec5\u5728<a href="/refund">\u9000\u6b3e\u653f\u7b56</a>\u8981\u6c42\u7684\u8303\u56f4\u5185\u9000\u6b3e\u3002</p>

<h2>6. \u77e5\u8bc6\u4ea7\u6743</h2>
<p>\u672c\u670d\u52a1\u53ca\u5176\u8f6f\u4ef6\u3001\u8bbe\u8ba1\u3001\u6587\u672c\u3001\u5546\u6807\u5747\u4e3a ${merchantZh} \u6216\u8bb8\u53ef\u65b9\u6240\u6709\u3002\u6211\u4eec\u6388\u4e88\u60a8\u5728\u6709\u6548\u8ba2\u9605\u671f\u95f4\u8fdb\u884c\u4e2a\u4eba\u6216\u5185\u90e8\u5546\u4e1a\u4f7f\u7528\u7684\u6709\u9650\u3001\u975e\u72ec\u5360\u3001\u4e0d\u53ef\u8f6c\u8ba9\u8bb8\u53ef\u3002</p>

<h2>7. \u7528\u6237\u5185\u5bb9</h2>
<p>\u60a8\u4fdd\u7559\u901a\u8fc7\u672c\u670d\u52a1\u63d0\u4ea4\u7684\u63d0\u793a\u8bcd\u3001\u4ee3\u7801\u53ca\u5176\u4ed6\u5185\u5bb9\u7684\u6240\u6709\u6743\u3002\u7531\u4e8e\u5185\u5bb9\u5728\u8bbe\u5907\u95f4\u91c7\u7528\u7aef\u5230\u7aef\u52a0\u5bc6\uff0c\u6211\u4eec\u65e0\u6cd5\u8bbf\u95ee\u3002\u60a8\u5bf9\u4f20\u8f93\u5185\u5bb9\u8d1f\u5168\u9762\u8d23\u4efb\u3002</p>

<h2>8. \u514d\u8d23\u58f0\u660e</h2>
<p>\u672c\u670d\u52a1\u6309<strong>\u201c\u73b0\u6709\u72b6\u6001\u201d</strong>\u4e0e<strong>\u201c\u53ef\u7528\u72b6\u6001\u201d</strong>\u63d0\u4f9b\u3002\u5728\u6cd5\u5f8b\u5141\u8bb8\u8303\u56f4\u5185\uff0c\u6211\u4eec\u4e0d\u63d0\u4f9b\u4efb\u4f55\u660e\u793a\u6216\u9ed8\u793a\u62c5\u4fdd\uff08\u9002\u9500\u6027\u3001\u7279\u5b9a\u7528\u9014\u7684\u9002\u7528\u6027\u3001\u4e0d\u4fb5\u6743\u7b49\uff09\u3002\u6211\u4eec\u4e0d\u4fdd\u8bc1\u670d\u52a1\u4e0d\u4e2d\u65ad\u3001\u65e0\u9519\u8bef\u6216\u5b89\u5168\u3002</p>

<h2>9. \u8d23\u4efb\u9650\u5236</h2>
<p>\u5728\u6cd5\u5f8b\u5141\u8bb8\u7684\u6700\u5927\u8303\u56f4\u5185\uff0c\u6211\u4eec\u5bf9\u672c\u6761\u6b3e\u6216\u670d\u52a1\u4ea7\u751f\u4efb\u4f55\u7d22\u8d54\u7684\u603b\u8d23\u4efb\u4e0d\u8d85\u8fc7\u7d22\u8d54\u524d 12 \u4e2a\u6708\u60a8\u5b9e\u9645\u652f\u4ed8\u91d1\u989d\u3002\u6211\u4eec\u4e0d\u5bf9\u95f4\u63a5\u3001\u9644\u5e26\u3001\u7279\u522b\u3001\u540e\u679c\u6216\u60e9\u7f5a\u6027\u635f\u5bb3\u8d1f\u8d23\u3002</p>

<h2>10. \u8d54\u507f</h2>
<p>\u60a8\u540c\u610f\u5c31\u56e0\u8bef\u7528\u670d\u52a1\u6216\u8fdd\u53cd\u672c\u6761\u6b3e\u4ea7\u751f\u7684\u4efb\u4f55\u7d22\u8d54\u4e3a ${merchantZh} \u8fdb\u884c\u8d54\u507f\u5e76\u4f7f\u5176\u514d\u53d7\u635f\u5bb3\u3002</p>

<h2>11. \u670d\u52a1\u6216\u6761\u6b3e\u53d8\u66f4</h2>
<p>\u6211\u4eec\u53ef\u80fd\u4fee\u6539\u672c\u670d\u52a1\u6216\u672c\u6761\u6b3e\uff0c\u91cd\u5927\u53d8\u66f4\u5c06\u5728\u672c\u9875\u9762\u516c\u544a\uff0c\u5728\u751f\u6548\u65e5\u540e\u7ee7\u7eed\u4f7f\u7528\u670d\u52a1\u5373\u8868\u793a\u63a5\u53d7\u3002</p>

<h2>12. \u7ec8\u6b62</h2>
<p>\u60a8\u53ef\u968f\u65f6\u7ec8\u6b62\u8d26\u6237\u3002\u6211\u4eec\u53ef\u4ee5\u56e0\u60a8\u8fdd\u53cd\u672c\u6761\u6b3e\u6216\u8bc8\u9a97\u884c\u4e3a\u6682\u505c\u6216\u7ec8\u6b62\u670d\u52a1\uff0c\u5408\u7406\u60c5\u51b5\u4e0b\u63d0\u524d\u901a\u77e5\u3002</p>

<h2>13. \u9002\u7528\u6cd5\u5f8b\u4e0e\u4e89\u8bae</h2>
<p>\u672c\u6761\u6b3e\u9002\u7528\u4e2d\u534e\u4eba\u6c11\u5171\u548c\u56fd\u6cd5\u5f8b\u3002\u4e89\u8bae\u9996\u5148\u901a\u8fc7\u53cb\u597d\u534f\u5546\u89e3\u51b3\u3002\u534f\u5546\u4e0d\u6210\u7684\uff0c\u63d0\u4ea4 ${merchantZh} \u6ce8\u518c\u5730\u6240\u5728\u5730\u6709\u7ba1\u8f96\u6743\u7684\u4eba\u6c11\u6cd5\u9662\u88c1\u51b3\u3002</p>

<h2>14. \u8054\u7cfb\u65b9\u5f0f</h2>
<p>${merchantZh}<br>
${addrZh}<br>
\u90ae\u7bb1\uff1a<a href="mailto:${email}">${email}</a><br>
\u7535\u8bdd\uff1a${phone}</p>
`;

	return renderPolicyShell(env, {
		active: "terms",
		titleEn: "Terms of Service",
		titleZh: "\u670d\u52a1\u6761\u6b3e",
		bodyEn,
		bodyZh,
	});
}

// ── Contact Us ────────────────────────────────────────────

export function renderContactPage(env: Env): string {
	const merchantEn = escapeHtml(env.MERCHANT_NAME);
	const merchantZh = escapeHtml(env.MERCHANT_NAME_CN || env.MERCHANT_NAME);
	const addrEn = escapeHtml(env.MERCHANT_ADDRESS);
	const addrZh = escapeHtml(env.MERCHANT_ADDRESS_CN || env.MERCHANT_ADDRESS);
	const email = escapeHtml(env.SUPPORT_EMAIL);
	const phone = escapeHtml(env.SUPPORT_PHONE);

	const bodyEn = `
<p>We're here to help. Reach us through any of the channels below.</p>

<div class="contact-card">
  <div class="contact-row">
    <div class="contact-label">Merchant</div>
    <div class="contact-value">${merchantEn}</div>
  </div>
  <div class="contact-row">
    <div class="contact-label">Business Address</div>
    <div class="contact-value">${addrEn}</div>
  </div>
  <div class="contact-row">
    <div class="contact-label">Support Email</div>
    <div class="contact-value"><a href="mailto:${email}">${email}</a></div>
  </div>
  <div class="contact-row">
    <div class="contact-label">Support Phone</div>
    <div class="contact-value">${phone}</div>
  </div>
  <div class="contact-row">
    <div class="contact-label">Response Time</div>
    <div class="contact-value">Within 24 hours on business days (Monday&ndash;Friday, excluding public holidays).</div>
  </div>
  <div class="contact-row">
    <div class="contact-label">Business Hours</div>
    <div class="contact-value">Monday&ndash;Friday, 09:00&ndash;18:00 (UTC+8)</div>
  </div>
</div>

<h2>What to Include</h2>
<p>To help us resolve your issue quickly, please include in your message:</p>
<ul>
  <li>Your account email or Telegram/WeChat ID.</li>
  <li>PayPal transaction ID or redeem code, if your question is about a payment.</li>
  <li>VS Code version and operating system, if your question is about a bug.</li>
  <li>Screenshots or a brief description of what you were doing when the issue occurred.</li>
</ul>

<h2>Common Topics</h2>
<ul>
  <li><strong>Billing &amp; refunds</strong> &mdash; see our <a href="/refund">Refund Policy</a> first; most questions are answered there.</li>
  <li><strong>Cancel a subscription</strong> &mdash; cancel directly inside PayPal, or email us.</li>
  <li><strong>Privacy / data deletion</strong> &mdash; see our <a href="/privacy">Privacy Policy</a> and email us with your account details.</li>
  <li><strong>Bug reports / feature requests</strong> &mdash; please include reproduction steps.</li>
</ul>

<p>Before opening a PayPal dispute or chargeback, please contact us first &mdash; we want to make it right.</p>
`;

	const bodyZh = `
<p>\u6211\u4eec\u968f\u65f6\u4e3a\u60a8\u63d0\u4f9b\u5e2e\u52a9\uff0c\u8bf7\u901a\u8fc7\u4ee5\u4e0b\u4efb\u4e00\u6e20\u9053\u8054\u7cfb\u6211\u4eec\u3002</p>

<div class="contact-card">
  <div class="contact-row">
    <div class="contact-label">\u5546\u6237\u540d\u79f0</div>
    <div class="contact-value">${merchantZh}</div>
  </div>
  <div class="contact-row">
    <div class="contact-label">\u7ecf\u8425\u5730\u5740</div>
    <div class="contact-value">${addrZh}</div>
  </div>
  <div class="contact-row">
    <div class="contact-label">\u5ba2\u670d\u90ae\u7bb1</div>
    <div class="contact-value"><a href="mailto:${email}">${email}</a></div>
  </div>
  <div class="contact-row">
    <div class="contact-label">\u5ba2\u670d\u7535\u8bdd</div>
    <div class="contact-value">${phone}</div>
  </div>
  <div class="contact-row">
    <div class="contact-label">\u54cd\u5e94\u65f6\u6548</div>
    <div class="contact-value">\u5de5\u4f5c\u65e5 24 \u5c0f\u65f6\u5185\u54cd\u5e94\uff08\u5468\u4e00\u81f3\u5468\u4e94\uff0c\u6cd5\u5b9a\u8282\u5047\u65e5\u987a\u5ef6\uff09\u3002</div>
  </div>
  <div class="contact-row">
    <div class="contact-label">\u670d\u52a1\u65f6\u95f4</div>
    <div class="contact-value">\u5468\u4e00\u81f3\u5468\u4e94 09:00\u201318:00\uff08UTC+8\uff09</div>
  </div>
</div>

<h2>\u54a8\u8be2\u65f6\u8bf7\u63d0\u4f9b</h2>
<p>\u4e3a\u4fbf\u5feb\u901f\u5904\u7406\uff0c\u8bf7\u5728\u90ae\u4ef6\u4e2d\u9644\u4e0a\uff1a</p>
<ul>
  <li>\u8d26\u6237\u90ae\u7bb1\u6216 Telegram / \u5fae\u4fe1 ID\u3002</li>
  <li>\u6d89\u53ca\u4ed8\u6b3e\u65f6\uff0c\u8bf7\u63d0\u4f9b PayPal \u4ea4\u6613\u53f7\u6216\u5151\u6362\u7801\u3002</li>
  <li>\u6d89\u53ca\u7a0b\u5e8f\u95ee\u9898\u65f6\uff0c\u8bf7\u63d0\u4f9b VS Code \u7248\u672c\u4e0e\u64cd\u4f5c\u7cfb\u7edf\u3002</li>
  <li>\u95ee\u9898\u53d1\u751f\u65f6\u7684\u622a\u56fe\u6216\u7b80\u8981\u63cf\u8ff0\u3002</li>
</ul>

<h2>\u5e38\u89c1\u4e3b\u9898</h2>
<ul>
  <li><strong>\u8ba1\u8d39\u4e0e\u9000\u6b3e</strong> \u2014 \u8bf7\u5148\u67e5\u770b<a href="/refund">\u9000\u6b3e\u653f\u7b56</a>\uff0c\u5927\u591a\u6570\u95ee\u9898\u80fd\u5728\u90a3\u91cc\u627e\u5230\u7b54\u6848\u3002</li>
  <li><strong>\u53d6\u6d88\u8ba2\u9605</strong> \u2014 \u53ef\u5728 PayPal \u5185\u76f4\u63a5\u53d6\u6d88\uff0c\u6216\u53d1\u90ae\u4ef6\u7531\u6211\u4eec\u4ee3\u4e3a\u5904\u7406\u3002</li>
  <li><strong>\u9690\u79c1\u4e0e\u6570\u636e\u5220\u9664</strong> \u2014 \u8be6\u89c1<a href="/privacy">\u9690\u79c1\u653f\u7b56</a>\uff0c\u53d1\u90ae\u4ef6\u8054\u7cfb\u6211\u4eec\u3002</li>
  <li><strong>\u9519\u8bef\u62a5\u544a / \u529f\u80fd\u8bf7\u6c42</strong> \u2014 \u8bf7\u9644\u4e0a\u590d\u73b0\u6b65\u9aa4\u3002</li>
</ul>

<p>\u53d1\u8d77 PayPal Dispute \u6216\u4fe1\u7528\u5361 chargeback \u524d\uff0c\u8bf7\u5148\u8054\u7cfb\u6211\u4eec\u2014\u2014\u6211\u4eec\u613f\u610f\u4ee5\u8bda\u4fe1\u539f\u5219\u89e3\u51b3\u3002</p>
`;

	return renderPolicyShell(env, {
		active: "contact",
		titleEn: "Contact Us",
		titleZh: "\u8054\u7cfb\u6211\u4eec",
		bodyEn,
		bodyZh,
	});
}
