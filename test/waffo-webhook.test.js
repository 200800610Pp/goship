/**
 * test/waffo-webhook.test.js — Waffo Webhook 事件处理验证
 * 载荷结构参照官方文档：@waffo/pancake-ts docs/webhook-guide.md
 * 用法：先启动本地服务器（node src/server.js），再执行 node test/waffo-webhook.test.js
 */
'use strict';

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8787';
let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`  ${c ? '✅' : '❌'} ${n} ${extra}`); };

function jar() {
  const m = new Map();
  return {
    apply(r) {
      const sc = r.headers.getSetCookie?.() || [];
      const one = r.headers.get('set-cookie');
      if (one && !sc.length) sc.push(one);
      for (const c of sc) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) m.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
    },
    h() { return [...m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    get(n) { return m.get(n); },
  };
}

async function post(path, body, headers = {}) {
  return fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function loginDemo() {
  const j = jar();
  let r = await fetch(BASE + '/login'); j.apply(r);
  const csrf = j.get('gs_csrf');
  r = await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { cookie: j.h(), 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@goship.dev', password: 'demo123456' }),
  });
  j.apply(r);
  return j;
}

/** 构造一条符合官方结构的 Waffo 事件 */
function waffoEvent(eventType, data, extra = {}) {
  return {
    id: 'delivery-' + Math.random().toString(36).slice(2, 10),
    timestamp: new Date().toISOString(),
    eventType,
    eventId: data.orderId || data.paymentId || 'EVT-1',
    storeId: 'STO_TEST',
    storeName: '[TEST] Store',
    mode: 'test',
    data,
    ...extra,
  };
}

async function main() {
  console.log('Waffo Webhook 测试：\n');

  /* 0. 前置：把 demo 用户重置为 free */
  const j0 = jar();
  let r = await fetch(BASE + '/login'); j0.apply(r);
  const csrf0 = j0.get('gs_csrf');
  await fetch(BASE + '/api/login', {
    method: 'POST',
    headers: { cookie: j0.h(), 'x-csrf-token': csrf0, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@goship.dev', password: 'admin123456' }),
  }).then((res) => j0.apply(res));
  const adminUsers = await (await fetch(BASE + '/api/admin/users', { headers: { cookie: j0.h() } })).json();
  const demoId = adminUsers.users.find((u) => u.email === 'demo@goship.dev')?.id;
  const setPlan = (plan) => fetch(BASE + '/api/admin/users', {
    method: 'POST',
    headers: { cookie: j0.h(), 'x-csrf-token': csrf0, 'content-type': 'application/json' },
    body: JSON.stringify({ userId: demoId, plan }),
  });
  r = await setPlan('free');
  ok(r.status === 200, '前置：把 demo 用户重置为 free 套餐');

  /* 1. order.completed（一次性买断成功）→ 自动开通 pro */
  let ev = waffoEvent('order.completed', {
    orderId: 'ORD-TEST-0001', orderStatus: 'completed', buyerEmail: 'demo@goship.dev',
    currency: 'USD', chargedAmount: '29.00', amount: '29.00', productName: 'GoShip Pro 专业版',
  });
  r = await post('/api/payments/webhook', ev);
  const res1 = await r.json();
  ok(r.status === 200 && res1.message === 'success', 'order.completed → {"message":"success"}', JSON.stringify(res1));

  let me = await (await fetch(BASE + '/api/me', { headers: { cookie: (await loginDemo()).h() } })).json();
  ok(me.user?.plan === 'pro', `用户套餐自动升级为 pro（当前：${me.user?.plan}）`);

  /* 2. 团队版识别 */
  ev = waffoEvent('order.completed', {
    orderId: 'ORD-TEST-0002', orderStatus: 'completed', buyerEmail: 'demo@goship.dev',
    currency: 'USD', chargedAmount: '139.00', productName: 'GoShip 团队版',
  });
  r = await post('/api/payments/webhook', ev);
  ok((await r.json()).message === 'success', '团队版订单 → success');
  me = await (await fetch(BASE + '/api/me', { headers: { cookie: (await loginDemo()).h() } })).json();
  ok(me.user?.plan === 'team', `套餐识别为 team（当前：${me.user?.plan}）`);

  /* 3. subscription.activated → 开通 */
  ev = waffoEvent('subscription.activated', {
    orderId: 'ORD-TEST-0003', orderStatus: 'active', buyerEmail: 'demo@goship.dev',
    currency: 'USD', chargedAmount: '14.00', billingPeriod: 'yearly', productName: 'GoShip 更新订阅',
  });
  r = await post('/api/payments/webhook', ev);
  ok((await r.json()).message === 'success', 'subscription.activated → success');

  /* 4. subscription.canceling（软取消，周期内仍可用）*/
  ev = waffoEvent('subscription.canceling', {
    orderId: 'ORD-TEST-0003', orderStatus: 'canceling', buyerEmail: 'demo@goship.dev', currency: 'USD',
  });
  r = await post('/api/payments/webhook', ev);
  ok((await r.json()).message === 'success', 'subscription.canceling → success');
  me = await (await fetch(BASE + '/api/me', { headers: { cookie: (await loginDemo()).h() } })).json();
  ok(me.user?.plan === 'team' && me.user?.subscription?.status === 'canceling',
    `软取消：仍保留 ${me.user?.plan} 套餐，状态 ${me.user?.subscription?.status}`);

  /* 5. subscription.canceled → 降级 */
  ev = waffoEvent('subscription.canceled', {
    orderId: 'ORD-TEST-0003', orderStatus: 'canceled', buyerEmail: 'demo@goship.dev', currency: 'USD',
  });
  r = await post('/api/payments/webhook', ev);
  ok((await r.json()).message === 'success', 'subscription.canceled → success');
  me = await (await fetch(BASE + '/api/me', { headers: { cookie: (await loginDemo()).h() } })).json();
  ok(me.user?.plan === 'free', `取消后降级为 free（当前：${me.user?.plan}）`);

  /* 6. refund.succeeded → 降级 */
  await setPlan('pro');
  ev = waffoEvent('refund.succeeded', {
    orderId: 'ORD-TEST-0004', orderStatus: 'refunded', buyerEmail: 'demo@goship.dev',
    currency: 'USD', refundedAmount: '29.00', refundStatus: 'succeeded',
  });
  r = await post('/api/payments/webhook', ev);
  ok((await r.json()).message === 'success', 'refund.succeeded → success');
  me = await (await fetch(BASE + '/api/me', { headers: { cookie: (await loginDemo()).h() } })).json();
  ok(me.user?.plan === 'free', `退款后降级为 free（当前：${me.user?.plan}）`);

  /* 7. 未注册邮箱 → unknown（不误开通） */
  ev = waffoEvent('order.completed', {
    orderId: 'ORD-TEST-0005', orderStatus: 'completed', buyerEmail: 'nobody@example.com',
    currency: 'USD', chargedAmount: '29.00',
  });
  r = await post('/api/payments/webhook', ev);
  ok((await r.json()).message === 'unknown', '未注册邮箱 → unknown（不误开通）');

  /* 8. 非法 JSON 不应导致 500 */
  r = await post('/api/payments/webhook', '{not valid json');
  ok(r.status === 200, '非法 JSON → 仍返回 200（不崩溃）');

  /* 9. 缺邮箱字段 → unknown */
  ev = waffoEvent('order.completed', { orderId: 'ORD-TEST-0006', orderStatus: 'completed', currency: 'USD' });
  r = await post('/api/payments/webhook', ev);
  ok((await r.json()).message === 'unknown', '缺邮箱字段 → unknown');

  /* 10. 未处理的事件类型 → success（确认收到，避免 Waffo 无谓重试） */
  ev = waffoEvent('token.created', { tokenId: 'TOK-TEST-1', buyerEmail: 'demo@goship.dev' });
  r = await post('/api/payments/webhook', ev);
  ok((await r.json()).message === 'success', '未处理事件类型 → success（不触发重试）');

  /* 收尾：恢复 demo 用户为 pro */
  r = await setPlan('pro');
  ok(r.status === 200, '收尾：恢复 demo 用户为 pro 套餐');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试异常：', e); process.exit(1); });
