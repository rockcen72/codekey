// Client-side i18n script. Returned inline into every page so a
// single language toggle reskins the whole site (nav, footer,
// merchant info, page-specific data-i18n keys). The English copy
// is the source of truth; Chinese is a translation. PayPal
// requires English policy pages; Chinese is offered for buyers
// in mainland China.

import type { Env } from "./shared";

export function i18nScript(env: Env, extra?: { zh: Record<string, string>; en: Record<string, string> }): string {
	const zhExtra = extra?.zh ?? {};
	const enExtra = extra?.en ?? {};
	return `<script>
const PAYPAL_CLIENT_ID = ${JSON.stringify(env.PAYPAL_CLIENT_ID || "")};
const PAYPAL_CONFIGURED = !!PAYPAL_CLIENT_ID && !PAYPAL_CLIENT_ID.includes('placeholder') && !PAYPAL_CLIENT_ID.startsWith('sandbox-');
const CHINA_PAY_URL = ${JSON.stringify(env.CHINA_PAY_URL || "")};
const MERCHANT_NAME_EN = ${JSON.stringify(env.MERCHANT_NAME || "")};
const MERCHANT_NAME_CN = ${JSON.stringify(env.MERCHANT_NAME_CN || env.MERCHANT_NAME || "")};
const MERCHANT_ADDRESS_EN = ${JSON.stringify(env.MERCHANT_ADDRESS || "")};
const MERCHANT_ADDRESS_CN = ${JSON.stringify(env.MERCHANT_ADDRESS_CN || env.MERCHANT_ADDRESS || "")};

const i18n = {
  zh: ${JSON.stringify({ ...zhStrings(), ...zhExtra })},
  en: ${JSON.stringify({ ...enStrings(), ...enExtra })},
};

let currentLang = 'en';

function applyLang(lang) {
  currentLang = lang;
  const dict = i18n[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (dict[key] !== undefined) el.innerHTML = dict[key];
  });
  document.querySelectorAll('[data-badge]').forEach(el => {
    if (dict['badge']) el.dataset.badge = dict['badge'];
  });
  const toggle = document.getElementById('langToggle');
  if (toggle) toggle.textContent = dict['lang-label'];
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

  const nameEl = document.querySelector('.footer-merchant-name');
  const addrEl = document.querySelector('.footer-merchant-address');
  if (nameEl) nameEl.textContent = lang === 'zh' ? MERCHANT_NAME_CN : MERCHANT_NAME_EN;
  if (addrEl) addrEl.textContent = lang === 'zh' ? MERCHANT_ADDRESS_CN : MERCHANT_ADDRESS_EN;

  if (typeof onLangChange === 'function') onLangChange(lang);

  if (!PAYPAL_CONFIGURED) {
    const downgrade = lang === 'zh' ? '\u5373\u5c06\u5f00\u653e \u00b7 \u6682\u7528\u5151\u6362\u7801' : 'Coming soon \u00b7 use redeem code';
    document.querySelectorAll('.subscribe-btn.primary').forEach(btn => {
      btn.textContent = downgrade;
      btn.style.background = '#94a3b8';
      btn.style.cursor = 'not-allowed';
    });
    const note = document.querySelector('.paypal-note');
    if (note) {
      note.innerHTML = lang === 'zh'
        ? '\ud83d\udca1 PayPal \u63a5\u5165\u4e2d\u3002\u56fd\u5185\u7528\u6237\u53ef\u76f4\u63a5\u8d2d\u4e70\u5151\u6362\u7801\uff08\u4e0b\u65b9\uff09\u3002'
        : '\ud83d\udca1 PayPal coming soon. China users can buy a redeem code below right now.';
    }
  }
}

function toggleLang() {
  applyLang(currentLang === 'en' ? 'zh' : 'en');
}

const browserLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
applyLang(browserLang.startsWith('zh') ? 'zh' : 'en');
</script>`;
}

function enStrings(): Record<string, string> {
	return {
		"nav-home": "Home",
		"nav-refund": "Refund Policy",
		"nav-terms": "Terms of Service",
		"nav-privacy": "Privacy Policy",
		"nav-contact": "Contact Us",
		"footer-merchant": "Merchant",
		"footer-legal": "Legal & Support",
		"footer-email": "Email",
		"footer-phone": "Phone",
		"footer-copyright": "\u00a9 2026 CodeKey. All rights reserved.",
		"policy-effective": "Effective Date",
		"lang-label": "\ud83c\udde8\ud83c\uddf3 \u4e2d\u6587",
	};
}

function zhStrings(): Record<string, string> {
	return {
		"nav-home": "\u9996\u9875",
		"nav-refund": "\u9000\u6b3e\u653f\u7b56",
		"nav-terms": "\u670d\u52a1\u6761\u6b3e",
		"nav-privacy": "\u9690\u79c1\u653f\u7b56",
		"nav-contact": "\u8054\u7cfb\u6211\u4eec",
		"footer-merchant": "\u5546\u6237\u4fe1\u606f",
		"footer-legal": "\u6cd5\u5f8b\u4e0e\u652f\u6301",
		"footer-email": "\u90ae\u7bb1",
		"footer-phone": "\u7535\u8bdd",
		"footer-copyright": "\u00a9 2026 CodeKey. \u4fdd\u7559\u6240\u6709\u6743\u5229\u3002",
		"policy-effective": "\u751f\u6548\u65e5\u671f",
		"lang-label": "\ud83c\uddfa\ud83c\uddf8 English",
	};
}
