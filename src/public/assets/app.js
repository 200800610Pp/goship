/**
 * app.js — GoShip 前端逻辑（零依赖原生 JS）
 * 模块：会话、表单、仪表盘、管理后台、埋点、Toast、FAQ
 */
'use strict';

/* ================= 通用 ================= */
const GOSHIP = {
  api: '/api',
  payments: {
    // Waffo Pancake 商品支付链接（生产模式）
    provider: 'waffo',
    publicKey: '',
    proUrl: 'https://pancake.waffo.ai/store/goship-j57atm5t/product/PROD_3ZflUOmYxYRlYn414rsaR9?type=onetime&currency=USD',
    teamUrl: 'https://pancake.waffo.ai/store/goship-j57atm5t/product/PROD_6ZSs9kFOm8R6UbOqkOVPNX?type=onetime&currency=USD',
    updateUrl: 'https://pancake.waffo.ai/store/goship-j57atm5t/product/PROD_5Cg7BmwvyQFPjocTLjbfCo?type=subscription&currency=USD',
  },
};

function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function getCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function api(method, path, body) {
  const opts = { method, headers: { 'x-csrf-token': getCookie('gs_csrf') || '' } };
  if (body != null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(GOSHIP.api + path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, data };
}

/* 埋点：页面浏览 */
function trackPage() {
  try {
    fetch(GOSHIP.api + '/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pageview', path: location.pathname }),
    }).catch(() => {});
  } catch { /* 忽略 */ }
}
trackPage();

/* FAQ 折叠 */
$$('.faq-item h3').forEach((h) => {
  h.addEventListener('click', () => h.parentElement.classList.toggle('open'));
});

/* ================= 会话 ================= */
let ME = null;

async function loadMe() {
  const { status, data } = await api('GET', '/me');
  if (status === 200) {
    ME = data.user;
    return ME;
  }
  return null;
}

function setAuthUI(user) {
  const slots = $$('[data-auth]');
  if (!user) return;
  slots.forEach((el) => {
    const prop = el.dataset.auth;
    if (prop === 'name') el.textContent = user.name || user.email;
    else if (prop === 'email') el.textContent = user.email;
    else if (prop === 'plan') el.textContent = user.plan === 'free' ? '免费版' : user.plan === 'pro' ? '专业版' : '团队版';
  });
}

/* ================= 登录 / 注册 / 退出 ================= */
const loginForm = $('#login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    err.classList.remove('show');
    const { status, data } = await api('POST', '/login', {
      email: $('#email').value, password: $('#password').value,
    });
    if (status === 200) {
      const next = new URLSearchParams(location.search).get('next') || '/dashboard';
      location.href = next;
    } else {
      err.textContent = (data && data.error) || '登录失败';
      err.classList.add('show');
    }
  });
}

const regForm = $('#register-form');
if (regForm) {
  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#form-error');
    err.classList.remove('show');
    if ($('#password').value !== $('#password2').value) {
      err.textContent = '两次输入的密码不一致';
      err.classList.add('show');
      return;
    }
    const { status, data } = await api('POST', '/register', {
      email: $('#email').value, password: $('#password').value,
      name: $('#name').value, inviteCode: $('#invite-code') ? $('#invite-code').value : '',
    });
    if (status === 201) {
      location.href = '/dashboard?welcome=1';
    } else {
      err.textContent = (data && data.error) || '注册失败';
      err.classList.add('show');
    }
  });
}

const logoutBtn = $('#logout-btn');
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    await api('POST', '/logout');
    location.href = '/';
  });
}

/* ================= 仪表盘 ================= */
async function initDashboard() {
  const user = await loadMe();
  if (!user) { location.href = '/login?next=/dashboard'; return; }
  setAuthUI(user);
  const sub = user.subscription;
  const subEl = $('#sub-status');
  if (subEl) {
    if (sub && sub.status === 'active') {
      subEl.innerHTML = `<span class="badge badge-ok">订阅中 · ${esc(sub.plan)}</span>`;
    } else {
      subEl.innerHTML = `<span class="badge badge-free">免费版</span> <a href="/pricing">升级 →</a>`;
    }
  }
  if (new URLSearchParams(location.search).get('welcome')) toast('🎉 注册成功，欢迎上船！');
  await loadProjects();
}

async function loadProjects() {
  const list = $('#project-list');
  if (!list) return;
  const { status, data } = await api('GET', '/projects');
  if (status !== 200) return;
  list.innerHTML = data.projects.map((p) => `
    <tr data-id="${p.id}">
      <td><strong>${esc(p.name)}</strong><br><span class="muted small">${esc(p.description || '')}</span></td>
      <td><span class="badge ${p.status === 'active' ? 'badge-ok' : 'badge-free'}">${p.status === 'active' ? '进行中' : p.status === 'paused' ? '暂停' : '完成'}</span></td>
      <td class="muted small">${new Date(p.createdAt).toLocaleDateString('zh-CN')}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="delProject('${p.id}')">删除</button></td>
    </tr>`).join('') || '<tr><td colspan="4" class="muted">还没有项目，创建第一个吧 👇</td></tr>';
}

const projectForm = $('#project-form');
if (projectForm) {
  projectForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { status, data } = await api('POST', '/projects', {
      name: $('#project-name').value, description: $('#project-desc').value,
    });
    if (status === 201) {
      toast('✅ 项目已创建');
      projectForm.reset();
      loadProjects();
      loadDashStats();
    } else {
      toast((data && data.error) || '创建失败');
    }
  });
}

async function delProject(id) {
  await api('DELETE', '/projects/' + id);
  loadProjects();
  loadDashStats();
}

/* 资料修改（昵称/密码） */
const profileForm = $('#profile-form');
if (profileForm) {
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    if ($('#profile-name').value.trim()) body.name = $('#profile-name').value.trim();
    if ($('#profile-password').value) body.password = $('#profile-password').value;
    if (!Object.keys(body).length) { toast('没有需要保存的修改'); return; }
    const { status, data } = await api('POST', '/profile', body);
    if (status === 200) {
      toast('✅ 资料已更新');
      profileForm.reset();
      ME = data.user;
      setAuthUI(ME);
    } else {
      toast((data && data.error) || '保存失败');
    }
  });
}

/* ================= 管理后台 ================= */
async function initAdmin() {
  const user = await loadMe();
  if (!user || user.role !== 'admin') { location.href = '/login?next=/admin'; return; }
  setAuthUI(user);
  await Promise.all([loadAdminStats(), loadAdminUsers()]);
}

async function loadAdminStats() {
  const el = $('#admin-stats');
  if (!el) return;
  const { data } = await api('GET', '/admin/stats');
  if (!data) return;
  el.innerHTML = `
    <div class="mini-stat"><div class="v">${data.users}</div><div class="l">总用户（7 天新增 ${data.newUsers7d}）</div></div>
    <div class="mini-stat"><div class="v">${data.activeSubscriptions}</div><div class="l">有效订阅 · MRR ¥${data.mrr}</div></div>
    <div class="mini-stat"><div class="v">${data.projects}</div><div class="l">项目数 · ${data.posts} 篇文章</div></div>`;
  const tp = $('#top-pages');
  if (tp) {
    tp.innerHTML = (data.topPages || []).map(([p, n]) => `<tr><td>${esc(p)}</td><td>${n}</td></tr>`).join('')
      || '<tr><td colspan="2" class="muted">暂无访问数据</td></tr>';
  }
}

async function loadAdminUsers() {
  const el = $('#admin-users');
  if (!el) return;
  const { data } = await api('GET', '/admin/users');
  if (!data) return;
  el.innerHTML = data.users.map((u) => `
    <tr data-uid="${u.id}">
      <td>${esc(u.name)}<br><span class="muted small">${esc(u.email)}</span></td>
      <td><span class="badge badge-admin">${u.role === 'admin' ? '管理员' : '用户'}</span></td>
      <td><span class="badge ${u.plan === 'free' ? 'badge-free' : 'badge-pro'}">${u.plan}</span></td>
      <td class="muted small">${u.createdAt ? new Date(u.createdAt).toLocaleDateString('zh-CN') : ''}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="adminUser('${u.id}', {plan:'pro'})">升 Pro</button>
        <button class="btn btn-ghost btn-sm" onclick="adminUser('${u.id}', {banned:${!u.banned}})">${u.banned ? '解封' : '封禁'}</button>
      </td>
    </tr>`).join('');
}

async function adminUser(userId, patch) {
  const { status } = await api('POST', '/admin/users', { userId, ...patch });
  if (status === 200) { toast('已更新'); loadAdminUsers(); loadAdminStats(); }
}

/* 全局暴露给内联 onclick */
window.delProject = delProject;
window.adminUser = adminUser;

/* ================= 支付（购买按钮） ================= */
const BUY_URLS = {
  pro: () => GOSHIP.payments.proUrl,
  team: () => GOSHIP.payments.teamUrl,
  update: () => GOSHIP.payments.updateUrl,
};
$$('[data-buy]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault(); // 阻止 <a> 的默认跳转（href="/register"）
    const plan = btn.dataset.buy;
    const url = (BUY_URLS[plan] || (() => ''))();
    if (!url) {
      toast('支付功能即将上线');
      return;
    }
    window.location.href = url;
  });
});

/* ================= 启动 ================= */
document.addEventListener('DOMContentLoaded', () => {
  if (document.body.dataset.page === 'dashboard') initDashboard();
  if (document.body.dataset.page === 'admin') initAdmin();
  if (document.body.dataset.page === 'auth') loadMe().then((u) => { if (u) location.href = '/dashboard'; });
});
