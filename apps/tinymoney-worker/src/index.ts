interface Env {
  RELAY_BACKEND_URL: string;
  PAYPAL_CLIENT_ID: string;
  CHINA_PAY_URL: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(renderPage(env), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/paypal/create-order') {
      return handleCreateOrder(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/paypal/capture-order') {
      return handleCaptureOrder(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/paypal/webhook') {
      return handleWebhook(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleCreateOrder(request: Request, env: Env): Promise<Response> {
  try {
    const { plan } = await request.json() as { plan: string };
    const prices: Record<string, { price: string; description: string }> = {
      monthly: { price: '9.99', description: 'CodeKey Pro Monthly' },
      yearly: { price: '99.99', description: 'CodeKey Pro Yearly' },
    };
    const product = prices[plan];
    if (!product) return json({ error: 'Invalid plan' }, 400);

    const accessToken = await getPayPalAccessToken(env);
    const order = await fetch('https://api-m.paypal.com/v2/checkout/orders', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: product.description,
          amount: { currency_code: 'USD', value: product.price },
          custom_id: plan,
        }],
      }),
    });
    const data: any = await order.json();
    return json({ id: data.id });
  } catch (err) {
    return json({ error: 'Failed to create order' }, 500);
  }
}

async function handleCaptureOrder(request: Request, env: Env): Promise<Response> {
  try {
    const { orderId, userId } = await request.json() as { orderId: string; userId?: string };
    const accessToken = await getPayPalAccessToken(env);
    const capture = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    const data: any = await capture.json();
    if (data.status === 'COMPLETED') {
      const plan = data.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id || 'monthly';
      const days = plan === 'yearly' ? 365 : 30;
      // Notify relay to activate subscription
      if (userId) {
        await fetch(`${env.RELAY_BACKEND_URL}/api/v1/subscription/activate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userId, plan, durationDays: days }),
        }).catch(() => {});
      }
      return json({ status: 'COMPLETED', plan, days });
    }
    return json({ status: data.status });
  } catch (err) {
    return json({ error: 'Failed to capture order' }, 500);
  }
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const body: any = await request.json();
    if (body.event_type === 'CHECKOUT.ORDER.APPROVED') {
      const orderId = body.resource?.id;
      if (orderId) {
        const accessToken = await getPayPalAccessToken(env);
        await fetch(`https://api-m.paypal.com/v2/checkout/orders/${orderId}/capture`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });
      }
    }
    return json({ received: true });
  } catch {
    return json({ error: 'Webhook error' }, 500);
  }
}

async function getPayPalAccessToken(env: Env): Promise<string> {
  const basic = btoa(`${env.PAYPAL_CLIENT_ID}:`);
  const resp = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data: any = await resp.json();
  return data.access_token;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function renderPage(env: Env): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodeKey Pro</title>
<script src="https://www.paypal.com/sdk/js?client-id=${env.PAYPAL_CLIENT_ID}&currency=USD" data-sdk-integration-source="button-factory"></script>
<style>
:root {
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

.lang-bar { text-align: right; margin-bottom: 8px; }
.lang-btn { border: 1px solid var(--border); background: var(--surface); color: var(--muted); padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; cursor: pointer; }
.lang-btn:hover { border-color: var(--primary); color: var(--primary); }

header { text-align: center; margin-bottom: 32px; }
header h1 { font-size: 28px; font-weight: 800; margin-bottom: 6px; }
header p { color: var(--muted); font-size: 14px; line-height: 1.6; }

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
.plan-features li::before { content: "✓ "; color: var(--success); font-weight: 700; }
.subscribe-btn { display: block; width: 100%; padding: 10px; border: 0; border-radius: 8px; font-size: 14px; font-weight: 700; text-align: center; cursor: pointer; text-decoration: none; margin-top: auto; }
.subscribe-btn.primary { background: var(--primary); color: #fff; }
.subscribe-btn.primary:hover { background: #1d4ed8; }
.paypal-button-container { margin-top: 8px; min-height: 40px; }

.paypal-note { text-align: center; color: var(--muted); font-size: 12px; margin-bottom: 24px; line-height: 1.5; }

.china-row { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 32px; padding: 16px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.china-row-text { color: var(--muted); font-size: 13px; }
.china-row-text strong { color: var(--text); }
.china-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 18px; border: 0; border-radius: 8px; background: #e53e3e; color: #fff; font-size: 13px; font-weight: 700; text-decoration: none; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.china-btn:hover { background: #c53030; }

.guide-section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 32px; }
.guide-section h2 { font-size: 15px; font-weight: 800; margin-bottom: 10px; }
.guide-section ol { padding-left: 18px; }
.guide-section li { padding: 5px 0; font-size: 13px; line-height: 1.6; color: var(--muted); }
.guide-section li strong { color: var(--text); }

.faq-section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
.faq-section h2 { font-size: 15px; font-weight: 800; margin-bottom: 12px; }
.faq-item { padding: 10px 0; border-bottom: 1px solid var(--border); }
.faq-item:last-child { border-bottom: 0; }
.faq-q { font-weight: 700; font-size: 13px; margin-bottom: 3px; }
.faq-a { color: var(--muted); font-size: 12px; line-height: 1.6; }

.status-banner { display: none; padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; font-weight: 600; text-align: center; }
.status-banner.success { display: block; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
.status-banner.error { display: block; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }

footer { text-align: center; padding: 20px 0; color: var(--muted); font-size: 12px; }

@media (max-width: 640px) {
  .plans { flex-direction: column; }
  .china-row { flex-direction: column; text-align: center; }
}
</style>
</head>
<body>
<div class="container">
  <div class="lang-bar">
    <button class="lang-btn" id="langToggle" onclick="toggleLang()">🇨🇳 中文</button>
  </div>

  <header>
    <h1 id="title">CodeKey Pro</h1>
    <p id="subtitle">Unlock unlimited devices, full session history, E2E encryption & priority support</p>
  </header>

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
      <div class="plan-price">$9.99 <span data-i18n="plan-monthly-period">/month</span></div>
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
      <div class="plan-price">$99.99 <span data-i18n="plan-yearly-period">/year</span></div>
      <div class="plan-desc" data-i18n="plan-yearly-desc">Save 17% — $8.33/month</div>
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

  <p class="paypal-note" data-i18n="paypal-note">💳 PayPal, credit card, and debit card accepted. Subscription activates automatically after payment.</p>

  <div class="china-row">
    <span class="china-row-text" data-i18n="china-text"><strong>🇨🇳 China users:</strong> Alipay, WeChat Pay, and bank cards. Buy a redeem code, then activate in VS Code.</span>
    <a class="china-btn" href="${env.CHINA_PAY_URL}" target="_blank" data-i18n="china-btn">Buy Redeem Code →</a>
  </div>

  <div class="guide-section">
    <h2 data-i18n="guide-title">How to Subscribe</h2>
    <ol>
    <li data-i18n="guide-1"><strong>Choose a plan</strong> — Click "Subscribe with PayPal" on your preferred plan</li>
    <li data-i18n="guide-2"><strong>Complete payment</strong> — Log in to PayPal and confirm. Subscription activates automatically.</li>
    <li data-i18n="guide-3"><strong>Enjoy</strong> — Refresh your phone to see the Pro badge</li>
    </ol>
  </div>

  <div class="faq-section">
    <h2 data-i18n="faq-title">FAQ</h2>
    <div class="faq-item">
      <div class="faq-q" data-i18n="faq-1-q">What's included in the free plan?</div>
      <div class="faq-a" data-i18n="faq-1-a">New users get a 14-day free trial with full Pro features. After the trial, you get 50 approvals per month on 1 device with limited history.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q" data-i18n="faq-2-q">How do I activate after payment?</div>
      <div class="faq-a" data-i18n="faq-2-a">PayPal payments activate automatically. For China payments, enter the redeem code in the VS Code sidebar footer.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q" data-i18n="faq-3-q">Can I cancel anytime?</div>
      <div class="faq-a" data-i18n="faq-3-a">Yes. Monthly and yearly plans can be cancelled anytime. Access continues until the end of the current billing period.</div>
    </div>
    <div class="faq-item">
      <div class="faq-q" data-i18n="faq-4-q">What does "unlimited devices" mean?</div>
      <div class="faq-a" data-i18n="faq-4-a">Pro users can pair multiple VS Code windows or machines to the same CodeKey account. Free plan is limited to 1 device.</div>
    </div>
  </div>

  <footer>
    <p>CodeKey &copy; 2026 · <span data-i18n="footer-contact">QQ Group 827453239</span></p>
  </footer>
</div>

<script>
const i18n = {
  zh: {
    'title': 'CodeKey Pro',
    'subtitle': '解锁无限审批、多设备管理、端到端加密和优先支持',
    'plan-free-name': 'Free',
    'plan-free-period': '/月',
    'plan-free-desc': '含 14 天试用，之后每月 50 次审批',
    'plan-free-f1': '1 台设备',
    'plan-free-f2': '每月 50 次审批',
    'plan-free-f3': '有限会话历史',
    'plan-free-f4': '社区支持',
    'plan-free-current': '当前已在使用',
    'plan-monthly-name': 'Pro 月付',
    'plan-monthly-period': '/月',
    'plan-monthly-desc': '无限使用，随时取消',
    'plan-monthly-btn': 'PayPal 订阅',
    'plan-yearly-name': 'Pro 年付',
    'plan-yearly-period': '/年',
    'plan-yearly-desc': '省 17% — $8.33/月',
    'plan-yearly-btn': 'PayPal 订阅',
    'plan-pro-f1': '无限设备',
    'plan-pro-f2': '无限审批',
    'plan-pro-f3': '完整会话历史',
    'plan-pro-f4': '端到端加密',
    'plan-pro-f5': '优先支持',
    'paypal-note': '💳 支持 PayPal、信用卡、借记卡支付，支付成功后自动激活订阅。',
    'china-text': '<strong>🇨🇳 国内用户：</strong>支持支付宝、微信支付、银行卡。购买兑换码后在 VS Code 侧边栏输入激活。',
    'china-btn': '购买兑换码 →',
    'guide-title': '订阅指南',
    'guide-1': '<strong>选择方案</strong> — 点击心仪方案下的"PayPal 订阅"按钮',
    'guide-2': '<strong>完成支付</strong> — 登录 PayPal 确认支付，订阅自动激活',
    'guide-3': '<strong>开始使用</strong> — 刷新手机端即可看到 Pro 标识',
    'faq-title': '常见问题',
    'faq-1-q': '免费版包含什么？',
    'faq-1-a': '新用户首次配对自动获得 14 天 Pro 试用。试用结束后每月有 50 次审批额度，限 1 台设备。',
    'faq-2-q': '支付后如何激活？',
    'faq-2-a': 'PayPal 支付自动激活。国内支付购买的兑换码，请在 VS Code 侧边栏底部输入。',
    'faq-3-q': '可以随时取消吗？',
    'faq-3-a': '可以。月付和年付均可随时取消，当前周期结束后停止续费。',
    'faq-4-q': '"无限设备"是什么意思？',
    'faq-4-a': 'Pro 用户可以在多个 VS Code 窗口或电脑上配对同一 CodeKey 账号。免费版限 1 台设备。',
    'footer-contact': 'QQ 群 827453239',
    'lang-label': '🇺🇸 English',
    'badge': '推荐',
  },
  en: {
    'title': 'CodeKey Pro',
    'subtitle': 'Unlock unlimited approvals, multi-device support, E2E encryption & priority support',
    'plan-free-name': 'Free',
    'plan-free-period': '/month',
    'plan-free-desc': '14-day trial included, then 50 approvals/month',
    'plan-free-f1': '1 device',
    'plan-free-f2': '50 approvals / month',
    'plan-free-f3': 'Limited session history',
    'plan-free-f4': 'Community support',
    'plan-free-current': 'Currently active',
    'plan-monthly-name': 'Pro Monthly',
    'plan-monthly-period': '/month',
    'plan-monthly-desc': 'Unlimited everything, cancel anytime',
    'plan-monthly-btn': 'Subscribe with PayPal',
    'plan-yearly-name': 'Pro Yearly',
    'plan-yearly-period': '/year',
    'plan-yearly-desc': 'Save 17% — $8.33/month',
    'plan-yearly-btn': 'Subscribe with PayPal',
    'plan-pro-f1': 'Unlimited devices',
    'plan-pro-f2': 'Unlimited approvals',
    'plan-pro-f3': 'Full session history',
    'plan-pro-f4': 'End-to-end encryption',
    'plan-pro-f5': 'Priority support',
    'paypal-note': '💳 PayPal, credit card, and debit card accepted. Subscription activates automatically after payment.',
    'china-text': '<strong>🇨🇳 China users:</strong> Alipay, WeChat Pay, and bank cards. Buy a redeem code, then activate in VS Code.',
    'china-btn': 'Buy Redeem Code →',
    'guide-title': 'How to Subscribe',
    'guide-1': '<strong>Choose a plan</strong> — Click "Subscribe with PayPal" on your preferred plan',
    'guide-2': '<strong>Complete payment</strong> — Log in to PayPal and confirm. Subscription activates automatically.',
    'guide-3': '<strong>Enjoy</strong> — Refresh your phone to see the Pro badge',
    'faq-title': 'FAQ',
    'faq-1-q': "What's included in the free plan?",
    'faq-1-a': 'New users get a 14-day free trial with full Pro features. After the trial, you get 50 approvals per month on 1 device with limited history.',
    'faq-2-q': 'How do I activate after payment?',
    'faq-2-a': 'PayPal payments activate automatically. For China payments, enter the redeem code in the VS Code sidebar footer.',
    'faq-3-q': 'Can I cancel anytime?',
    'faq-3-a': 'Yes. Monthly and yearly plans can be cancelled anytime. Access continues until the end of the current billing period.',
    'faq-4-q': 'What does "unlimited devices" mean?',
    'faq-4-a': 'Pro users can pair multiple VS Code windows or machines to the same CodeKey account. Free plan is limited to 1 device.',
    'footer-contact': 'QQ Group 827453239',
    'lang-label': '🇨🇳 中文',
    'badge': 'Recommended',
  },
};

let currentLang = 'en';

function applyLang(lang) {
  currentLang = lang;
  const dict = i18n[lang];
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (dict[key] !== undefined) {
      el.innerHTML = dict[key];
    }
  });
  document.querySelectorAll('[data-badge]').forEach(el => {
    el.dataset.badge = dict['badge'];
  });
  document.getElementById('langToggle').textContent = dict['lang-label'];
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
}

function toggleLang() {
  applyLang(currentLang === 'en' ? 'zh' : 'en');
}

// Auto-detect browser language
const browserLang = (navigator.language || navigator.userLanguage || '').toLowerCase();
applyLang(browserLang.startsWith('zh') ? 'zh' : 'en');

function showStatus(msg, type) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.className = 'status-banner ' + type;
  setTimeout(() => { el.className = 'status-banner'; }, 5000);
}

function startPayPal(plan) {
  const container = document.getElementById('paypal-button-' + plan);
  container.style.display = 'block';
  container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (container.dataset.rendered) return;
  container.dataset.rendered = '1';
  renderPayPal('paypal-button-' + plan, plan);
}

async function createOrder(plan) {
  const resp = await fetch('/api/paypal/create-order', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Failed to create order');
  return data.id;
}

async function onApprove(orderId, plan) {
  try {
    const resp = await fetch('/api/paypal/capture-order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orderId, plan }),
    });
    const data = await resp.json();
    if (data.status === 'COMPLETED') {
      showStatus(i18n[currentLang]['title'] === 'CodeKey Pro' ? '🎉 Subscription successful! Thank you for your support' : '🎉 订阅成功！感谢你的支持', 'success');
    } else {
      showStatus(i18n[currentLang]['title'] === 'CodeKey Pro' ? 'Payment processing, please check status later' : '支付处理中，请稍后查看状态', 'success');
    }
  } catch (err) {
    showStatus(i18n[currentLang]['title'] === 'CodeKey Pro' ? 'Payment confirmation failed, please contact support' : '支付确认失败，请联系客服', 'error');
  }
}

function renderPayPal(containerId, plan) {
  if (typeof paypal === 'undefined') return;
  paypal.Buttons({
    createOrder: () => createOrder(plan),
    onApprove: (data) => onApprove(data.orderID, plan),
    onError: (err) => showStatus(i18n[currentLang]['title'] === 'CodeKey Pro' ? 'PayPal error, please try again' : 'PayPal 支付出错，请重试', 'error'),
  }).render('#' + containerId);
}

// PayPal buttons render on-demand via startPayPal()
</script>
</body>
</html>`;
}
