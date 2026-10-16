/**
 * server.js — GoShip 零依赖 HTTP 服务器
 * 仅用 Node.js 内置模块。入口：node src/server.js
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const { JsonDb } = require('./lib/db');
const auth = require('./lib/auth');
const util = require('./lib/util');

const db = new JsonDb(config.dataDir).load();
seedIfEmpty();

const generalLimiter = new util.RateLimiter(config.limits.rate);
const authLimiter = new util.RateLimiter(config.limits.authRate);

/* ================= 静态资源 MIME ================= */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

/* ================= 内容加载（博客/文档） ================= */
function loadContent(dir) {
  const out = [];
  const full = path.join(config.contentDir, dir);
  if (!fs.existsSync(full)) return out;
  for (const f of fs.readdirSync(full)) {
    if (!f.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8'));
      doc.file = f;
      out.push(doc);
    } catch (e) { console.error('[content] 解析失败', f, e.message); }
  }
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

const BLOG_POSTS = loadContent('posts');
const DOC_PAGES = loadContent('docs');

/* ================= 会话管理 ================= */
const SESSION_COOKIE = 'gs_session';

function createSession(user, req, res) {
  const token = auth.newSessionToken();
  const expiresAt = Date.now() + config.sessionTtlMs;
  db.insert('sessions', {
    tokenHash: auth.hashToken(token),
    userId: user.id,
    expiresAt,
    createdAt: new Date().toISOString(),
    userAgent: util.basicUserAgent(req),
  });
  res.setHeader('Set-Cookie', auth.serializeCookie(
    SESSION_COOKIE, auth.sign(token, config.sessionSecret),
    { maxAge: Math.floor(config.sessionTtlMs / 1000), httpOnly: true }
  ));
  return token;
}

function getSessionUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  const signed = cookies[SESSION_COOKIE];
  if (!signed) return null;
  const token = auth.unsign(signed, config.sessionSecret);
  if (!token) return null;
  const sess = db.findOne('sessions', (s) => s.tokenHash === auth.hashToken(token));
  if (!sess || sess.expiresAt < Date.now()) return null;
  return db.findOne('users', (u) => u.id === sess.userId) || null;
}

function destroySession(req, res) {
  const cookies = auth.parseCookies(req.headers.cookie);
  const signed = cookies[SESSION_COOKIE];
  if (signed) {
    const token = auth.unsign(signed, config.sessionSecret);
    if (token) db.remove('sessions', (s) => s.tokenHash === auth.hashToken(token));
  }
  res.setHeader('Set-Cookie', auth.serializeCookie(SESSION_COOKIE, '', { maxAge: 0 }));
}

/* ================= 支付 Webhook 工具（Waffo） ================= */
/** 读取原始请求体：验签必须使用未经解析的原始字符串 */
function readRawBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); resolve({ error: 'body_too_large' }); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!req.destroyed) resolve({ raw: Buffer.concat(chunks).toString('utf8') }); });
    req.on('error', () => resolve({ error: 'read_error' }));
  });
}

/**
 * 解析 Waffo 签名请求头。
 * 官方格式：X-Waffo-Signature: t=<时间戳>,v1=<Base64 签名>
 * 参考：@waffo/pancake-ts docs/webhook-guide.md
 */
function parseWaffoSignature(header) {
  if (!header) return null;
  const parts = {};
  for (const kv of String(header).split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return parts.v1 ? { t: parts.t, v1: parts.v1 } : null;
}

/**
 * Waffo 官方验签：RSA-SHA256，验签对象为 `${时间戳}.${原始请求体}`，签名为 Base64。
 * 含时间戳防重放检查（默认：过去 45 分钟、未来 1 分钟）。
 */
function verifyWaffoSignature(rawBody, header, publicKeyPem, opts = {}) {
  const toleranceMs = opts.toleranceMs != null ? opts.toleranceMs : config.sigToleranceMs;
  const futureToleranceMs = opts.futureToleranceMs != null ? opts.futureToleranceMs : 60000;

  const sig = parseWaffoSignature(header);
  if (!sig) return { ok: false, reason: 'header_format' };

  /* 防重放：时间戳窗口检查（t 可能是秒或毫秒，自动归一化） */
  if (toleranceMs > 0 && sig.t) {
    let ts = Number(sig.t);
    if (Number.isFinite(ts) && ts > 0) {
      if (ts < 1e12) ts *= 1000; // 秒 → 毫秒
      const age = Date.now() - ts;
      if (age > toleranceMs || age < -futureToleranceMs) {
        return { ok: false, reason: 'timestamp_out_of_range', age };
      }
    }
  }

  try {
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(`${sig.t}.${rawBody}`);
    verify.end();
    const ok = verify.verify(publicKeyPem, sig.v1, 'base64');
    return { ok, reason: ok ? 'ok' : 'signature_mismatch' };
  } catch (e) {
    console.error('[webhook] 验签异常：', e.message);
    return { ok: false, reason: 'exception', error: e.message };
  }
}

/** 递归查找第一个「键名匹配 keyRe 且值匹配 valRe」的字段（容忍不同平台的字段命名差异） */
function deepFind(obj, keyRe, valRe, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(obj)) {
    if (keyRe.test(k) && (v == null || typeof v !== 'object')) {
      const s = String(v);
      if (!valRe || valRe.test(s)) return s;
    }
    if (v && typeof v === 'object') {
      const found = deepFind(v, keyRe, valRe, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Waffo 事件类型（官方小写点号命名，见 @waffo/pancake-ts docs/webhook-guide.md）
 * - 开通/续费类：开通或延长套餐
 * - 降级类：取消套餐
 * - 软取消：仅标记，到期前仍可用
 * 其他类型（Token 生成等）一律「确认收到但不处理」，避免 Waffo 无谓重试。
 */
const GRANT_EVENTS = new Set([
  'order.completed',
  'subscription.activated',
  'subscription.renewed',
  'subscription.recovered',
  'subscription.payment_succeeded',
  'subscription.plan_changed',
  'subscription.uncanceled',
  /* 兼容旧版大写命名 */
  'PAYMENT_NOTIFICATION',
  'SUBSCRIPTION_STATUS_NOTIFICATION',
  'SUBSCRIPTION_PERIOD_CHANGED_NOTIFICATION',
  'SUBSCRIPTION_CHANGE_NOTIFICATION',
]);
const DOWNGRADE_EVENTS = new Set([
  'refund.succeeded',
  'subscription.canceled',
  'subscription.past_due',
  'REFUND_NOTIFICATION',
]);
const SOFT_CANCEL_EVENTS = new Set(['subscription.canceling']);
const ACK_ONLY_EVENTS = new Set(['refund.failed', 'subscription.plan_change_scheduled', 'subscription.plan_change_failed']);

/**
 * 归一化处理支付事件：
 * 事件类型 → 找用户（按邮箱）→ 开通/降级套餐
 * 返回 true 表示已处理（Waffo 要求回 {"message":"success"}）
 */
function applyPaymentEvent(ev) {
  const type = String(ev.eventType || ev.meta?.event_name || '').toLowerCase();

  /* 明确不处理的事件：确认收到，避免重试 */
  if (type && ACK_ONLY_EVENTS.has(type)) {
    console.log('[webhook] 已确认但不处理的事件类型：', type);
    return true;
  }

  const result = ev.data || ev.result || ev.data?.attributes || ev.data?.object || ev;
  const flat = JSON.stringify(result || {});
  const email = (result.buyerEmail || deepFind(result, /email/i, /@/) || '').toLowerCase();

  if (!email) {
    console.warn('[webhook] 事件中未找到邮箱字段，无法匹配用户。事件类型：', type);
    return false;
  }
  const user = db.findOne('users', (u) => u.email === email);
  if (!user) {
    console.warn('[webhook] 未找到对应用户（可能是未注册就付款），跳过：', email);
    return false;
  }

  /* 降级：退款成功 / 订阅取消 / 逾期未付 */
  if (DOWNGRADE_EVENTS.has(type)) {
    db.update('subscriptions', (s) => s.userId === user.id, { status: 'cancelled' });
    db.update('users', (u) => u.id === user.id, { plan: 'free' });
    console.log(`[webhook] ⚠️ 订阅取消/退款/逾期，用户已降级：${email}（事件 ${type}）`);
    return true;
  }

  /* 软取消：用户申请取消，但当前周期内仍可用 */
  if (SOFT_CANCEL_EVENTS.has(type)) {
    db.update('subscriptions', (s) => s.userId === user.id, { status: 'canceling' });
    console.log(`[webhook] 用户申请取消订阅（周期内仍可用）：${email}`);
    return true;
  }

  /* 开通 / 续费：仅处理明确的开通类事件，其余一律确认收到并忽略 */
  if (!GRANT_EVENTS.has(type)) {
    console.log('[webhook] 已忽略未处理的事件类型：', type);
    return true;
  }

  /* 套餐识别：只依据"产品名称的值"判断（注意：不能匹配整个 JSON 字符串，
     否则字段名 productName 里的 "pro" 会造成误判）；
     "更新订阅"等附加产品只更新订阅状态，不改变用户已有套餐 */
  const productText = [
    result.productName, result.productDescription,
    deepFind(result, /productName|product_name|variant_name/i) || '',
  ].filter(Boolean).join(' ');
  let plan;
  if (/(team|团队)/i.test(productText)) plan = 'team';
  else if (/(pro|专业)/i.test(productText)) plan = 'pro';
  else plan = user.plan || 'free';
  const amount = Number(result.chargedAmount || result.amount ||
    deepFind(result, /(chargedAmount|amount|total|price)/i, /^[\d.]+$/)) || 0;
  const externalId = result.orderId || result.paymentId ||
    deepFind(result, /(orderId|order_id|paymentId|subscriptionId|id)/i) || '';
  const existing = db.findOne('subscriptions', (s) => s.userId === user.id);
  const sub = {
    id: existing ? existing.id : util.uuid(),
    userId: user.id, plan, status: 'active', provider: 'waffo',
    amount, startedAt: new Date().toISOString(),
    expiresAt: Date.now() + 365 * 24 * 3600 * 1000, externalId,
  };
  if (existing) db.update('subscriptions', (s) => s.userId === user.id, sub);
  else db.insert('subscriptions', sub);
  db.update('users', (u) => u.id === user.id, { plan });
  console.log(`[webhook] ✅ 已开通「${plan}」套餐：${email}（订单 ${externalId || '未提供'}，金额 ${amount}）`);
  return true;
}

/* ================= 页面壳（服务端渲染博客/文档） ================= */
function pageShell({ title, bodyHtml, active = '', user = null, meta = {} }) {
  const navLinks = [
    { href: '/', label: '首页' },
    { href: '/pricing', label: '定价' },
    { href: '/blog', label: '博客' },
    { href: '/docs', label: '文档' },
  ];
  const userHtml = user
    ? `<a class="nav-link" href="/dashboard">${util.escapeHtml(user.name || user.email)}</a>`
    : `<a class="nav-link" href="/login">登录</a><a class="btn btn-sm btn-primary" href="/register">免费开始</a>`;
  const nav = navLinks.map((l) =>
    `<a class="nav-link${active === l.href ? ' active' : ''}" href="${l.href}">${l.label}</a>`).join('') + userHtml;
  const desc = util.escapeHtml(meta.description || config.SITE.tagline);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${util.escapeHtml(title)} · ${config.SITE.name} 出海快启</title>
<meta name="description" content="${desc}">
<meta property="og:title" content="${util.escapeHtml(title)}">
<meta property="og:description" content="${desc}">
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<header class="site-nav">
  <div class="container nav-inner">
    <a class="brand" href="/"><img src="/assets/logo.svg" alt="logo" width="28" height="28">GoShip<span class="brand-zh">出海快启</span></a>
    <nav class="nav-links">${nav}</nav>
  </div>
</header>
<main class="container page-body">
${bodyHtml}
</main>
<footer class="site-footer">
  <div class="container">
    <p>© ${new Date().getFullYear()} ${config.SITE.name} 出海快启 · <a href="/docs">文档</a> · <a href="/pricing">定价</a> · <a href="/terms">服务条款</a> · <a href="/privacy">隐私政策</a> · <a href="mailto:${util.escapeHtml(config.SITE.supportEmail)}">联系</a></p>
    <p class="muted">为中国独立开发者打造 · 零依赖 · 一次买断</p>
  </div>
</footer>
</body>
</html>`;
}

function renderBlogList() {
  const cards = BLOG_POSTS.map((p) => `
    <article class="post-card">
      <h3><a href="/blog/${util.escapeHtml(p.slug)}">${util.escapeHtml(p.title)}</a></h3>
      <p class="muted">${util.escapeHtml(p.date || '')} · ${util.escapeHtml((p.tags || []).join(' / '))}</p>
      <p>${util.escapeHtml(p.excerpt || '')}</p>
    </article>`).join('');
  return pageShell({
    title: '博客',
    active: '/blog',
    bodyHtml: `<div class="page-header"><h1>博客</h1><p class="lead">出海经验、增长实验与产品更新，全部公开。</p></div>${cards || '<p class="muted">暂无文章。</p>'}`,
  });
}

function renderBlogPost(slug) {
  const p = BLOG_POSTS.find((x) => x.slug === slug);
  if (!p) return null;
  return pageShell({
    title: p.title,
    meta: { description: p.excerpt || '' },
    active: '/blog',
    bodyHtml: `<article class="post">
      <p class="muted">${util.escapeHtml(p.date || '')} · ${util.escapeHtml((p.tags || []).join(' / '))}</p>
      <h1>${util.escapeHtml(p.title)}</h1>
      ${util.renderMarkdown(p.body)}
      <p><a href="/blog">← 返回博客</a></p>
    </article>`,
  });
}

function renderDocsPage(slug) {
  const d = DOC_PAGES.find((x) => x.slug === slug);
  const list = DOC_PAGES.map((x) =>
    `<li><a href="/docs/${util.escapeHtml(x.slug)}"${x.slug === slug ? ' class="active"' : ''}>${util.escapeHtml(x.title)}</a></li>`).join('');
  return pageShell({
    title: d ? d.title : '文档',
    active: '/docs',
    bodyHtml: `<div class="docs-layout">
      <aside class="docs-sidebar"><h4>使用文档</h4><ul>${list}</ul></aside>
      <article class="docs-content">${d ? `<h1>${util.escapeHtml(d.title)}</h1>${util.renderMarkdown(d.body)}` : '<h1>文档</h1><p>请选择左侧文档。</p>'}</article>
    </div>`,
  });
}

/* ================= 认证 API ================= */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, plan: u.plan,
    createdAt: u.createdAt, emailVerified: !!u.emailVerified,
    // 返回该用户最近一条订阅记录（不限状态），以便前端展示"取消中/已取消"等状态
    subscription: db.find('subscriptions', (s) => s.userId === u.id)
      .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0] || null,
  };
}

async function handleApi(req, res, url, ip, user) {
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]

  /* ---- 公开接口 ---- */
  if (url.pathname === '/api/health') {
    return util.sendJson(res, 200, { ok: true, name: config.SITE.name, version: '1.0.0', mode: config.mode, time: new Date().toISOString() });
  }

  /* ---- 支付 Webhook（Waffo RSA 验签 / 兼容旧版 HMAC，免 CSRF） ---- */
  if (url.pathname === '/api/payments/webhook' && req.method === 'POST') {
    const body = await readRawBody(req, config.limits.bodyMaxBytes);
    if (body.error) return util.sendJson(res, 200, { message: 'failed' });
    const raw = body.raw;
    /* Waffo 官方签名头为 X-Waffo-Signature（格式 t=...,v1=...）；兼容旧的 x-signature */
    const signature = req.headers['x-waffo-signature'] || req.headers['x-signature'];

    /* 1) 验签：必须使用原始请求体（不可先 parse 再 stringify）
     *    仅「本地 demo 模式 + 来自本机」的请求跳过验签（便于自动化测试）；
     *    生产环境（GOSHIP_MODE=production）永远强制验签。 */
    const isLocalDev = config.mode === 'demo' && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
    if (isLocalDev) {
      console.log('[webhook] 本地 demo 模式：跳过验签（生产环境不会跳过）');
    } else if (config.waffoPublicKeys.length) {
      /* 依次尝试所有已配置公钥（测试 + 生产），任一通过即视为合法 */
      const results = config.waffoPublicKeys.map((k) => verifyWaffoSignature(raw, signature, k));
      const passed = results.some((r) => r.ok);
      if (!passed) {
        const v = results[0] || { reason: 'no_key' };
        console.warn('[webhook] ❌ Waffo 签名验证失败，原因：', v.reason,
          v.age != null ? `（时间差 ${v.age}ms）` : '', `（已尝试 ${results.length} 把公钥）`);
        db.insert('payments', {
          id: util.uuid(), provider: 'waffo', event: 'invalid_signature',
          payload: { reason: v.reason, header: String(signature || '').slice(0, 120), head: raw.slice(0, 500), keysTried: results.length },
          createdAt: new Date().toISOString(),
        });
        return util.sendJson(res, 200, { message: 'failed' });
      }
    } else if (config.paymentWebhookSecret) {
      const expect = crypto.createHmac('sha256', config.paymentWebhookSecret).update(raw).digest('hex');
      if (!signature || signature !== expect) return util.sendJson(res, 200, { message: 'failed' });
    } else {
      console.warn('[webhook] ⚠️ 未配置支付公钥，已跳过验签（生产环境务必配置）');
    }

    /* 2) 解析并记录原始事件 */
    let ev;
    try { ev = JSON.parse(raw); } catch { return util.sendJson(res, 200, { message: 'failed' }); }
    const eventType = String(ev.eventType || ev.meta?.event_name || 'unknown');
    db.insert('payments', {
      id: util.uuid(), provider: config.waffoPublicKeys.length ? 'waffo' : 'legacy',
      event: eventType, payload: ev, createdAt: new Date().toISOString(),
    });

    /* 3) 处理事件（Waffo 语义：success / failed / unknown） */
    let handled = false;
    try { handled = applyPaymentEvent(ev); } catch (e) { console.error('[webhook] 处理异常：', e.message); }
    return util.sendJson(res, 200, { message: handled ? 'success' : 'unknown' });
  }

  /* ---- 埋点接口（公开） ---- */
  if (url.pathname === '/api/events' && req.method === 'POST') {
    const body = await util.parseBody(req, 64 * 1024);
    if (body.error) return util.sendJson(res, 400, { error: body.error });
    const { name, path: p } = body.value || {};
    if (name && String(name).length <= 60) {
      pendingEvents.push({ id: util.uuid(), name: String(name), path: String(p || '').slice(0, 200), ip, createdAt: new Date().toISOString() });
    }
    return util.sendJson(res, 202, { ok: true });
  }

  /* ---- 注册 ---- */
  if (url.pathname === '/api/register' && req.method === 'POST') {
    if (!authLimiter.hit(ip + ':register')) return util.sendJson(res, 429, { error: '请求过于频繁，请稍后再试' });
    if (!db.cache.settings.allowRegister) return util.sendJson(res, 403, { error: '注册暂时关闭，请稍后再来' });
    const body = await util.parseBody(req, config.limits.bodyMaxBytes);
    if (body.error) return util.sendJson(res, 400, { error: body.error });
    const v = body.value || {};
    const email = util.safeStr(v.email, 254).trim().toLowerCase();
    const password = util.safeStr(v.password, 128);
    const name = util.safeStr(v.name, 60).trim();
    if (!auth.isValidEmail(email)) return util.sendJson(res, 400, { error: '邮箱格式不正确' });
    if (password.length < 8) return util.sendJson(res, 400, { error: '密码至少 8 位' });
    if (!name) return util.sendJson(res, 400, { error: '请填写昵称' });
    if (config.inviteCode && v.inviteCode !== config.inviteCode) return util.sendJson(res, 400, { error: '邀请码不正确' });
    if (db.findOne('users', (u) => u.email === email)) return util.sendJson(res, 409, { error: '该邮箱已注册' });
    const user = {
      id: util.uuid(), email, name, role: 'user', plan: 'free',
      passHash: auth.hashPassword(password),
      createdAt: new Date().toISOString(), lastLoginAt: null, emailVerified: false,
    };
    db.insert('users', user);
    createSession(user, req, res);
    track('register', url.pathname, ip);
    return util.sendJson(res, 201, { user: publicUser(user) });
  }

  /* ---- 登录 ---- */
  if (url.pathname === '/api/login' && req.method === 'POST') {
    if (!authLimiter.hit(ip + ':login')) return util.sendJson(res, 429, { error: '尝试过于频繁，请 10 分钟后再试' });
    const body = await util.parseBody(req, config.limits.bodyMaxBytes);
    if (body.error) return util.sendJson(res, 400, { error: body.error });
    const v = body.value || {};
    const email = util.safeStr(v.email, 254).trim().toLowerCase();
    const password = util.safeStr(v.password, 128);
    const user = db.findOne('users', (u) => u.email === email);
    // 恒定时间比较：用户不存在也执行一次哈希，防邮箱枚举时序侧信道
    const ok = user ? auth.verifyPassword(password, user.passHash)
      : (auth.verifyPassword(password, auth.hashPassword('dummy')), false);
    if (!ok || !user) return util.sendJson(res, 401, { error: '邮箱或密码错误' });
    if (user.banned) return util.sendJson(res, 403, { error: '账号已被封禁' });
    db.update('users', (u) => u.id === user.id, { lastLoginAt: new Date().toISOString() });
    createSession(user, req, res);
    track('login', url.pathname, ip);
    return util.sendJson(res, 200, { user: publicUser(user) });
  }

  /* ---- 登出 ---- */
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    destroySession(req, res);
    return util.sendJson(res, 200, { ok: true });
  }

  /* ---- 当前用户 ---- */
  if (url.pathname === '/api/me') {
    if (!user) return util.sendJson(res, 401, { error: '未登录' });
    return util.sendJson(res, 200, { user: publicUser(user) });
  }

  /* ---- 更新资料 ---- */
  if (url.pathname === '/api/profile' && req.method === 'POST') {
    if (!user) return util.sendJson(res, 401, { error: '未登录' });
    const body = await util.parseBody(req, config.limits.bodyMaxBytes);
    if (body.error) return util.sendJson(res, 400, { error: body.error });
    const v = body.value || {};
    const patch = {};
    if (v.name) patch.name = util.safeStr(v.name, 60).trim();
    if (v.password) {
      const pw = util.safeStr(v.password, 128);
      if (pw.length < 8) return util.sendJson(res, 400, { error: '新密码至少 8 位' });
      patch.passHash = auth.hashPassword(pw);
    }
    if (Object.keys(patch).length) db.update('users', (u) => u.id === user.id, patch);
    return util.sendJson(res, 200, { user: publicUser(db.findOne('users', (u) => u.id === user.id)) });
  }

  /* ---- 示例业务：项目 CRUD ---- */
  if (url.pathname === '/api/projects') {
    if (!user) return util.sendJson(res, 401, { error: '未登录' });
    if (req.method === 'GET') {
      const list = db.find('projects', (p) => p.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return util.sendJson(res, 200, { projects: list });
    }
    if (req.method === 'POST') {
      const body = await util.parseBody(req, config.limits.bodyMaxBytes);
      if (body.error) return util.sendJson(res, 400, { error: body.error });
      const v = body.value || {};
      const name = util.safeStr(v.name, 80).trim();
      if (!name) return util.sendJson(res, 400, { error: '项目名称不能为空' });
      const proj = {
        id: util.uuid(), userId: user.id, name,
        description: util.safeStr(v.description, 300),
        status: 'active', createdAt: new Date().toISOString(),
      };
      db.insert('projects', proj);
      return util.sendJson(res, 201, { project: proj });
    }
  }
  const projMatch = url.pathname.match(/^\/api\/projects\/([\w-]+)$/);
  if (projMatch) {
    if (!user) return util.sendJson(res, 401, { error: '未登录' });
    const proj = db.findOne('projects', (p) => p.id === projMatch[1] && p.userId === user.id);
    if (!proj) return util.sendJson(res, 404, { error: '项目不存在' });
    if (req.method === 'DELETE') {
      db.remove('projects', (p) => p.id === proj.id);
      return util.sendJson(res, 200, { ok: true });
    }
    if (req.method === 'PATCH') {
      const body = await util.parseBody(req, config.limits.bodyMaxBytes);
      if (body.error) return util.sendJson(res, 400, { error: body.error });
      const v = body.value || {};
      const patch = {};
      if (v.name) patch.name = util.safeStr(v.name, 80).trim();
      if (v.description != null) patch.description = util.safeStr(v.description, 300);
      if (v.status) patch.status = ['active', 'paused', 'done'].includes(v.status) ? v.status : proj.status;
      db.update('projects', (p) => p.id === proj.id, patch);
      return util.sendJson(res, 200, { project: db.findOne('projects', (p) => p.id === proj.id) });
    }
  }

  /* ---- 管理后台 API ---- */
  if (url.pathname.startsWith('/api/admin/')) {
    if (!user || user.role !== 'admin') return util.sendJson(res, 403, { error: '需要管理员权限' });
    const adminSeg = seg.slice(2);

    if (adminSeg[0] === 'stats') {
      const users = db.col('users');
      const activeSubs = db.find('subscriptions', (s) => s.status === 'active');
      const mrr = activeSubs.reduce((acc, s) => acc + (Number(s.amount) || 0), 0);
      const topPages = {};
      for (const e of db.col('events')) {
        if (e.name === 'pageview') topPages[e.path] = (topPages[e.path] || 0) + 1;
      }
      return util.sendJson(res, 200, {
        users: users.length,
        newUsers7d: users.filter((u) => Date.now() - Date.parse(u.createdAt) < 7 * 24 * 3600 * 1000).length,
        projects: db.col('projects').length,
        activeSubscriptions: activeSubs.length,
        mrr,
        posts: BLOG_POSTS.length,
        topPages: Object.entries(topPages).sort((a, b) => b[1] - a[1]).slice(0, 10),
      });
    }
    if (adminSeg[0] === 'users') {
      if (req.method === 'GET') {
        return util.sendJson(res, 200, {
          users: db.col('users').map((u) => ({
            id: u.id, email: u.email, name: u.name, role: u.role, plan: u.plan,
            createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, banned: !!u.banned,
          })),
        });
      }
      if (req.method === 'POST') {
        const body = await util.parseBody(req, config.limits.bodyMaxBytes);
        if (body.error) return util.sendJson(res, 400, { error: body.error });
        const v = body.value || {};
        const target = db.findOne('users', (u) => u.id === v.userId);
        if (!target) return util.sendJson(res, 404, { error: '用户不存在' });
        const patch = {};
        if (v.plan && ['free', 'pro', 'team'].includes(v.plan)) patch.plan = v.plan;
        if (v.role && ['user', 'admin'].includes(v.role)) patch.role = v.role;
        if (v.banned != null) patch.banned = !!v.banned;
        db.update('users', (u) => u.id === target.id, patch);
        return util.sendJson(res, 200, { ok: true });
      }
    }
    if (adminSeg[0] === 'settings' && req.method === 'POST') {
      const body = await util.parseBody(req, config.limits.bodyMaxBytes);
      if (body.error) return util.sendJson(res, 400, { error: body.error });
      const v = body.value || {};
      if (v.allowRegister != null) db.setSetting('allowRegister', !!v.allowRegister);
      if (v.demoBanner != null) db.setSetting('demoBanner', !!v.demoBanner);
      if (v.siteName) db.setSetting('siteName', util.safeStr(v.siteName, 40));
      return util.sendJson(res, 200, { settings: db.cache.settings });
    }
    return util.sendJson(res, 404, { error: 'not_found' });
  }

  return util.sendJson(res, 404, { error: 'not_found' });
}

/* ================= 静态文件 ================= */
/** 无扩展名路由 → 页面文件映射（SEO 友好的 URL） */
const PAGE_MAP = {
  '/pricing': 'pricing.html',
  '/login': 'login.html',
  '/register': 'register.html',
  '/dashboard': 'dashboard.html',
  '/admin': 'admin.html',
  '/terms': 'terms.html',
  '/privacy': 'privacy.html',
};

/** HTML 响应统一注入：CSRF cookie、安全头、（演示模式）横幅 */
function writeHtml(res, html) {
  const csrf = crypto.randomBytes(24).toString('hex');
  const banner = (db.cache.settings.demoBanner && config.mode === 'demo')
    ? `<div class="demo-banner">🧪 演示模式：数据保存在本地 data/db.json。<a href="/register">立即体验 →</a></div>`
    : '';
  if (banner) html = html.replace(/<main[^>]*>/, (m) => m + banner);
  res.setHeader('Set-Cookie', auth.serializeCookie('gs_csrf', csrf, { httpOnly: false, maxAge: 3600 }));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(html);
}

function serveStatic(res, filePath) {
  const rel = path.relative(config.publicDir, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return util.sendText(res, 403, 'Forbidden');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  const ext = path.extname(filePath).toLowerCase();
  const isAsset = rel.startsWith('assets') || rel === 'favicon.ico';
  // HTML：读入内存以便注入 CSRF cookie 与演示横幅
  if (ext === '.html') {
    let html;
    try { html = fs.readFileSync(filePath, 'utf8'); } catch { return util.sendText(res, 500, 'Read Error'); }
    writeHtml(res, html);
    return true;
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': fs.statSync(filePath).size,
    'Cache-Control': isAsset ? 'public, max-age=300' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

/* ================= 埋点 ================= */
let pendingEvents = [];
setInterval(() => {
  if (!pendingEvents.length) return;
  const batch = pendingEvents;
  pendingEvents = [];
  for (const e of batch) db.col('events').push(e);
  db.persist();
}, 5000).unref();

function track(name, p, ip) {
  pendingEvents.push({ id: util.uuid(), name, path: p, ip, createdAt: new Date().toISOString() });
}

/* ================= 页面视图统计（异步不阻塞） ================= */
const PAGEVIEW_IGNORE = [/^\/api\//, /^\/assets\//, /\.(css|js|png|svg|ico|jpg|webp|woff2?)$/];
function countPageview(url) {
  if (PAGEVIEW_IGNORE.some((r) => r.test(url))) return;
  track('pageview', url.slice(0, 200), 'server');
}

/* ================= 路由 ================= */
async function router(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const ip = util.clientIp(req);
  const user = getSessionUser(req);

  /* 安全响应头（HTML） */
  const isHtml = !url.pathname.startsWith('/api/');

  /* 全局限流（本地 demo 模式豁免，便于自动化测试；生产环境始终生效） */
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!(config.mode === 'demo' && isLocal) && !generalLimiter.hit(ip)) {
    return util.sendText(res, 429, 'Too Many Requests');
  }

  /* CSRF：写方法需要 x-csrf-token 与 cookie 一致（webhook 除外） */
  if (url.pathname.startsWith('/api/') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      && url.pathname !== '/api/payments/webhook' && url.pathname !== '/api/events') {
    const cookies = auth.parseCookies(req.headers.cookie);
    if (req.headers['x-csrf-token'] !== cookies.gs_csrf) {
      return util.sendJson(res, 403, { error: 'csrf_token_missing', hint: '请刷新页面后重试' });
    }
  }

  /* API */
  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url, ip, user);
  }

  /* SEO 端点 */
  if (url.pathname === '/robots.txt') {
    return util.sendText(res, 200, `User-agent: *\nAllow: /\nSitemap: ${config.SITE.url}/sitemap.xml`);
  }
  if (url.pathname === '/sitemap.xml') {
    const urls = ['/', '/pricing', '/blog', '/docs', '/login', '/register', '/terms', '/privacy']
      .concat(BLOG_POSTS.map((p) => '/blog/' + p.slug))
      .concat(DOC_PAGES.map((d) => '/docs/' + d.slug))
      .map((u) => `<url><loc>${config.SITE.url}${u}</loc></url>`).join('');
    return util.sendText(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, 'application/xml; charset=utf-8');
  }

  /* 服务端渲染页面 */
  if (url.pathname === '/blog') return serveHtml(res, renderBlogList(), user, url);
  if (url.pathname.startsWith('/blog/')) {
    const html = renderBlogPost(decodeURIComponent(url.pathname.slice('/blog/'.length)));
    if (!html) return notFound(res);
    return serveHtml(res, html, user, url);
  }
  if (url.pathname === '/docs' || url.pathname === '/docs/') return serveHtml(res, renderDocsPage(DOC_PAGES[0]?.slug || ''), user, url);
  if (url.pathname.startsWith('/docs/')) return serveHtml(res, renderDocsPage(decodeURIComponent(url.pathname.slice('/docs/'.length))), user, url);

  /* 受保护页面 */
  if (url.pathname === '/dashboard') {
    if (!user) return util.redirect(res, '/login?next=/dashboard');
  }
  if (url.pathname === '/admin') {
    if (!user || user.role !== 'admin') return util.sendText(res, 403, 'Forbidden');
  }

  /* 静态文件 */
  let filePath = path.join(config.publicDir, url.pathname === '/' ? 'index.html' : (PAGE_MAP[url.pathname] || url.pathname));
  if (serveStatic(res, filePath)) return;

  /* SPA 风格回退：无扩展名路径 → index.html（前端 404 处理） */
  if (!path.extname(filePath)) {
    filePath = path.join(config.publicDir, 'index.html');
    if (serveStatic(res, filePath)) return;
  }
  notFound(res);
}

function serveHtml(res, html, user, url) {
  writeHtml(res, html);
  countPageview(url.pathname);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1 style="font-family:sans-serif;padding:40px">404 · 页面不存在 <a href="/">返回首页</a></h1>');
}

/* ================= 种子数据 ================= */
function seedIfEmpty() {
  if (db.col('users').length) return;
  console.log('[seed] 初始化演示数据…');
  const admin = {
    id: util.uuid(), email: 'admin@goship.dev', name: '站长', role: 'admin', plan: 'team',
    passHash: auth.hashPassword('admin123456'), createdAt: new Date().toISOString(),
    lastLoginAt: null, emailVerified: true,
  };
  const demo = {
    id: util.uuid(), email: 'demo@goship.dev', name: '演示用户', role: 'user', plan: 'pro',
    passHash: auth.hashPassword('demo123456'), createdAt: new Date().toISOString(),
    lastLoginAt: null, emailVerified: true,
  };
  db.col('users').push(admin, demo);
  db.col('projects').push(
    { id: util.uuid(), userId: demo.id, name: 'AI 简历优化器', description: '第一个出海 MVP，定价 $9/月', status: 'active', createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() },
    { id: util.uuid(), userId: demo.id, name: '独立开发者周报', description: '每周一封，已积累 1200 订阅', status: 'paused', createdAt: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString() },
    { id: util.uuid(), userId: demo.id, name: '跨境合规检查工具', description: 'De Minimis 之后卖家的刚需', status: 'active', createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() },
  );
  db.col('subscriptions').push({
    id: util.uuid(), userId: demo.id, plan: 'pro', status: 'active', provider: 'demo',
    amount: 399, startedAt: new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString(),
    expiresAt: Date.now() + 350 * 24 * 3600 * 1000, externalId: 'demo-order-001',
  });
  db.setSetting('plans', [
    { id: 'free', name: '免费版', price: 0, period: '永久', features: ['着陆页 + 定价页', '邮箱注册 / 登录', '博客 + 文档', 'JSON 数据库', 'MIT 协议（需保留版权）'] },
    { id: 'pro', name: '专业版', price: 29, period: '一次买断', features: ['免费版全部功能', '管理后台', 'Waffo Pancake 收款接入', '埋点分析', '商用授权（移除版权）', '12 个月免费更新'] },
    { id: 'team', name: '团队版', price: 999, period: '一次买断', features: ['专业版全部功能', '最多 5 人团队授权', '优先支持（48h 内响应）', '终身更新', '定制部署协助'] },
  ]);
  db.setSetting('updatePlan', { id: 'update', name: '更新订阅', price: 99, period: '每年' });
  db.persist();
}

/* ================= 启动 ================= */
const server = http.createServer((req, res) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  router(req, res).catch((e) => {
    console.error('[server] 未捕获错误：', e);
    if (!res.headersSent) util.sendText(res, 500, 'Internal Server Error');
    else res.end();
  });
});

/* 直接运行时才监听端口；被 require（单元测试）时不监听 */
if (require.main === module) {
  server.listen(config.port, config.host, () => {
    console.log('');
    console.log('  ⚡ GoShip 出海快启 已启动');
    console.log(`  ├─ 着陆页:   http://${config.host}:${config.port}`);
    console.log(`  ├─ 管理后台: http://${config.host}:${config.port}/admin`);
    console.log(`  ├─ 管理员:   admin@goship.dev / admin123456`);
    console.log(`  ├─ 演示用户: demo@goship.dev / demo123456`);
    console.log(`  └─ 模式:     ${config.mode}`);
    console.log('');
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function shutdown() {
  console.log('[server] 正在关闭，落盘数据…');
  db.flushSync();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

/* 导出内部函数供单元测试使用（不对外暴露为服务） */
module.exports = {
  server, db,
  parseWaffoSignature,
  verifyWaffoSignature,
  applyPaymentEvent,
};
