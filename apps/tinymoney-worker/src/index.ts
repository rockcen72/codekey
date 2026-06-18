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
<title>CodeKey Pro — 订阅</title>
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
.container { max-width: 720px; margin: 0 auto; padding: 40px 16px; }

header { text-align: center; margin-bottom: 40px; }
header h1 { font-size: 32px; font-weight: 800; margin-bottom: 8px; }
header p { color: var(--muted); font-size: 15px; line-height: 1.6; }

.plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 40px; }
.plan-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; display: flex; flex-direction: column; }
.plan-card.featured { border-color: var(--primary); box-shadow: 0 0 0 2px rgba(37,99,235,0.15); position: relative; }
.plan-card.featured::before { content: "推荐"; position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: var(--primary); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 12px; border-radius: 999px; }
.plan-name { font-size: 14px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.plan-price { font-size: 36px; font-weight: 800; margin-bottom: 4px; }
.plan-price span { font-size: 14px; font-weight: 400; color: var(--muted); }
.plan-desc { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
.plan-features { list-style: none; margin-bottom: 24px; flex: 1; }
.plan-features li { padding: 6px 0; font-size: 14px; }
.plan-features li::before { content: "✓ "; color: var(--success); font-weight: 700; }
.paypal-button-container { margin-top: auto; min-height: 45px; }
.paypal-button-container.disabled { opacity: 0.4; pointer-events: none; }

.china-pay-section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 40px; }
.china-pay-section h2 { font-size: 18px; font-weight: 800; margin-bottom: 12px; }
.china-pay-section p { color: var(--muted); font-size: 14px; line-height: 1.6; margin-bottom: 16px; }
.china-pay-btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 24px; background: #e53e3e; color: #fff; border: 0; border-radius: 8px; font-size: 15px; font-weight: 700; text-decoration: none; cursor: pointer; }
.china-pay-btn:hover { background: #c53030; }

.guide-section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 40px; }
.guide-section h2 { font-size: 18px; font-weight: 800; margin-bottom: 12px; }
.guide-section ol { padding-left: 20px; }
.guide-section li { padding: 6px 0; font-size: 14px; line-height: 1.6; color: var(--muted); }
.guide-section li strong { color: var(--text); }

.faq-section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
.faq-section h2 { font-size: 18px; font-weight: 800; margin-bottom: 16px; }
.faq-item { padding: 12px 0; border-bottom: 1px solid var(--border); }
.faq-item:last-child { border-bottom: 0; }
.faq-q { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
.faq-a { color: var(--muted); font-size: 13px; line-height: 1.6; }

.status-banner { display: none; padding: 12px 16px; border-radius: 8px; margin-bottom: 20px; font-size: 14px; font-weight: 600; text-align: center; }
.status-banner.success { display: block; background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
.status-banner.error { display: block; background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }

footer { text-align: center; padding: 20px 0; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>CodeKey Pro</h1>
    <p>解锁全部功能：多设备管理、完整会话历史、端到端加密、优先支持</p>
  </header>

  <div id="statusBanner" class="status-banner"></div>

  <div class="plans">
    <div class="plan-card">
      <div class="plan-name">Free</div>
      <div class="plan-price">$0 <span>/月</span></div>
      <div class="plan-desc">适合初次体验</div>
      <ul class="plan-features">
        <li>1 台设备</li>
        <li>基础审批功能</li>
        <li>有限会话历史</li>
        <li>社区支持</li>
      </ul>
      <div style="text-align:center;padding:12px 0;color:var(--muted);font-size:13px;">当前已在使用</div>
    </div>

    <div class="plan-card featured">
      <div class="plan-name">Pro 月付</div>
      <div class="plan-price">$9.99 <span>/月</span></div>
      <div class="plan-desc">按需订阅，随时取消</div>
      <ul class="plan-features">
        <li>无限设备</li>
        <li>完整会话历史</li>
        <li>端到端加密</li>
        <li>优先支持</li>
      </ul>
      <div class="paypal-button-container" id="paypal-button-monthly"></div>
    </div>

    <div class="plan-card">
      <div class="plan-name">Pro 年付</div>
      <div class="plan-price">$99.99 <span>/年</span></div>
      <div class="plan-desc">省 17%，相当于 $8.33/月</div>
      <ul class="plan-features">
        <li>无限设备</li>
        <li>完整会话历史</li>
        <li>端到端加密</li>
        <li>优先支持</li>
      </ul>
      <div class="paypal-button-container" id="paypal-button-yearly"></div>
    </div>
  </div>

  <div class="china-pay-section">
    <h2>🇨🇳 国内支付</h2>
    <p>无法使用 PayPal？你可以通过国内支付平台购买兑换码，然后在 CodeKey 侧边栏输入兑换码激活 Pro 订阅。</p>
    <a class="china-pay-btn" href="${env.CHINA_PAY_URL}" target="_blank">前往购买兑换码 →</a>
  </div>

  <div class="guide-section">
    <h2>📖 订阅指南</h2>
    <ol>
      <li><strong>选择方案</strong> — 点击上方 PayPal 按钮或国内支付链接</li>
      <li><strong>完成支付</strong> — PayPal 用户直接登录支付；国内用户购买兑换码</li>
      <li><strong>激活订阅</strong> — 支付成功后，在 VS Code 侧边栏底部输入兑换码激活</li>
      <li><strong>开始使用</strong> — 刷新手机端即可看到 Pro 标识</li>
    </ol>
  </div>

  <div class="faq-section">
    <h2>❓ 常见问题</h2>
    <div class="faq-item">
      <div class="faq-q">支付后如何激活？</div>
      <div class="faq-a">PayPal 支付成功后系统会自动激活订阅。国内支付购买的兑换码，请在 VS Code 侧边栏底部输入兑换。</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">可以随时取消吗？</div>
      <div class="faq-a">月付和年付均可随时取消，当前周期结束后不再续费，已付费用不退还。</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">国内用户如何支付？</div>
      <div class="faq-a">点击上方"前往购买兑换码"按钮，通过国内支付平台购买兑换码，然后在 VS Code 侧边栏输入即可激活。</div>
    </div>
    <div class="faq-item">
      <div class="faq-q">订阅后可以换绑设备吗？</div>
      <div class="faq-a">可以。Pro 用户支持无限设备，你可以在设置中随时添加或移除设备。</div>
    </div>
  </div>

  <footer>
    <p>CodeKey &copy; 2026 · 如有问题请联系 QQ 群 827453239</p>
  </footer>
</div>

<script>
const plans = { monthly: 'monthly', yearly: 'yearly' };

function showStatus(msg, type) {
  const el = document.getElementById('statusBanner');
  el.textContent = msg;
  el.className = 'status-banner ' + type;
  setTimeout(() => { el.className = 'status-banner'; }, 5000);
}

async function createOrder(plan) {
  const resp = await fetch('/api/paypal/create-order', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plan }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || '创建订单失败');
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
      showStatus('🎉 订阅成功！感谢你的支持', 'success');
    } else {
      showStatus('支付处理中，请稍后查看状态', 'success');
    }
  } catch (err) {
    showStatus('支付确认失败，请联系客服', 'error');
  }
}

function renderPayPal(containerId, plan) {
  if (typeof paypal === 'undefined') return;
  paypal.Buttons({
    createOrder: () => createOrder(plan),
    onApprove: (data) => onApprove(data.orderID, plan),
    onError: (err) => showStatus('PayPal 支付出错，请重试', 'error'),
  }).render('#' + containerId);
}

renderPayPal('paypal-button-monthly', 'monthly');
renderPayPal('paypal-button-yearly', 'yearly');
</script>
</body>
</html>`;
}
