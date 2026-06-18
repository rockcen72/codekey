// Shared types, layout fragments, and i18n bootstrap for the
// tinymoney-worker pages. Every page imports from here so the
// header nav, footer merchant info, and language toggle stay
// consistent across home + policy pages.

export interface Env {
	RELAY_BACKEND_URL: string;
	PAYPAL_CLIENT_ID: string;
	CHINA_PAY_URL: string;
	MERCHANT_NAME: string;
	MERCHANT_NAME_CN: string;
	MERCHANT_ADDRESS: string;
	MERCHANT_ADDRESS_CN: string;
	SUPPORT_EMAIL: string;
	SUPPORT_PHONE: string;
	EFFECTIVE_DATE: string;
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function commonStyles(): string {
	return `:root {
  --bg: #f5f0eb;
  --surface: #fcfaf8;
  --text: #1c1917;
  --muted: #78716c;
  --border: #e7e2dc;
  --primary: #2563eb;
  --success: #059669;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); min-height: 100vh; }
.container { max-width: 960px; margin: 0 auto; padding: 32px 16px; }
a { color: var(--primary); }
.lang-bar { text-align: right; margin-bottom: 8px; }
.lang-btn { border: 1px solid var(--border); background: var(--surface); color: var(--muted); padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; cursor: pointer; }
.lang-btn:hover { border-color: var(--primary); color: var(--primary); }
.top-nav { display: flex; justify-content: center; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
.top-nav a { color: var(--muted); font-size: 13px; font-weight: 600; text-decoration: none; padding: 6px 12px; border-radius: 6px; }
.top-nav a:hover { background: var(--surface); color: var(--primary); }
.top-nav a.active { color: var(--primary); background: rgba(37,99,235,0.08); }
.site-footer { margin-top: 48px; padding: 24px 16px; border-top: 1px solid var(--border); background: var(--surface); }
.footer-inner { max-width: 960px; margin: 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; font-size: 12px; color: var(--muted); }
.footer-col h4 { color: var(--text); font-size: 13px; font-weight: 700; margin-bottom: 8px; }
.footer-col p { line-height: 1.7; }
.footer-col a { color: var(--muted); text-decoration: none; display: block; padding: 2px 0; }
.footer-col a:hover { color: var(--primary); }
.footer-meta { max-width: 960px; margin: 16px auto 0; padding-top: 16px; border-top: 1px solid var(--border); text-align: center; font-size: 11px; color: var(--muted); }
@media (max-width: 640px) { .footer-inner { grid-template-columns: 1fr; } }
.policy-page h1 { font-size: 28px; font-weight: 800; margin-bottom: 6px; }
.policy-meta { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
.policy-page h2 { font-size: 17px; font-weight: 700; margin: 24px 0 8px; color: var(--text); }
.policy-page p, .policy-page li { font-size: 14px; line-height: 1.7; color: var(--text); }
.policy-page p { margin-bottom: 10px; }
.policy-page ul, .policy-page ol { padding-left: 22px; margin-bottom: 10px; }
.policy-page li { margin-bottom: 4px; }
.policy-page strong { color: var(--text); }
.contact-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin: 16px 0; }
.contact-row { display: flex; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 14px; }
.contact-row:last-child { border-bottom: 0; }
.contact-label { width: 140px; color: var(--muted); font-weight: 600; flex-shrink: 0; }
.contact-value { flex: 1; word-break: break-word; }`;
}

export function renderTopNav(active: string): string {
	const item = (key: string, href: string, label: string) =>
		`<a href="${href}" class="${active === key ? "active" : ""}" data-i18n="nav-${key}">${label}</a>`;
	return `<nav class="top-nav">
    ${item("home", "/", "Home")}
    ${item("refund", "/refund", "Refund Policy")}
    ${item("terms", "/terms", "Terms of Service")}
    ${item("privacy", "/privacy", "Privacy Policy")}
    ${item("contact", "/contact", "Contact Us")}
  </nav>`;
}

export function renderFooter(env: Env): string {
	return `<footer class="site-footer">
  <div class="footer-inner">
    <div class="footer-col">
      <h4 data-i18n="footer-merchant">Merchant</h4>
      <p>
        <strong class="footer-merchant-name">${escapeHtml(env.MERCHANT_NAME)}</strong><br>
        <span class="footer-merchant-address">${escapeHtml(env.MERCHANT_ADDRESS)}</span><br>
        <span data-i18n="footer-email">Email</span>: <a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a><br>
        <span data-i18n="footer-phone">Phone</span>: ${escapeHtml(env.SUPPORT_PHONE)}
      </p>
    </div>
    <div class="footer-col">
      <h4 data-i18n="footer-legal">Legal &amp; Support</h4>
      <a href="/refund" data-i18n="nav-refund">Refund Policy</a>
      <a href="/terms" data-i18n="nav-terms">Terms of Service</a>
      <a href="/privacy" data-i18n="nav-privacy">Privacy Policy</a>
      <a href="/contact" data-i18n="nav-contact">Contact Us</a>
    </div>
  </div>
  <div class="footer-meta">
    <span data-i18n="footer-copyright">&copy; 2026 CodeKey. All rights reserved.</span>
  </div>
</footer>`;
}
