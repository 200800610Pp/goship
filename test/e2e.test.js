/**
 * test/e2e.test.js — GoShip 端到端测试（零依赖，使用 Node 18+ 内置 fetch）
 * 用法：先启动服务器（node src/server.js），再执行 node test/e2e.test.js
 */
'use strict';

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8787';
let passed = 0, failed = 0;

function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name} ${extra}`); }
}

/** 极简 cookie jar */
function jar() {
  const map = new Map();
  return {
    apply(res) {
      const set = res.headers.getSetCookie?.() || [];
      const sc = res.headers.get('set-cookie');
      if (sc && !set.length) set.push(sc);
      for (const c of set) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() { return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
    get(name) { return map.get(name); },
  };
}

async function req(method, path, { cookies, csrf, body } = {}) {
  const headers = {};
  if (cookies) headers.cookie = cookies.header();
  if (csrf != null) headers['x-csrf-token'] = csrf;
  if (body != null) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body == null ? undefined : JSON.stringify(body), redirect: 'manual' });
  return res;
}

async function main() {
  console.log('GoShip E2E 测试开始：' + BASE + '\n');

  /* 1. 健康检查 */
  let res = await req('GET', '/api/health');
  ok(res.status === 200, 'GET /api/health → 200');

  /* 2. 页面可访问（且各不相同） */
  const pages = ['/', '/pricing', '/login', '/register', '/blog', '/docs', '/docs/quickstart', '/robots.txt', '/sitemap.xml'];
  let sizes = new Set();
  for (const p of pages) {
    res = await req('GET', p);
    sizes.add((await res.text()).length);
    ok(res.status === 200, `GET ${p} → 200`);
  }
  ok(sizes.size >= 7, `不同页面返回不同内容（${sizes.size}/9 种）`);

  /* 3. 未登录守卫 */
  res = await req('GET', '/dashboard');
  ok(res.status === 302 && (res.headers.get('location') || '').includes('/login'), 'GET /dashboard 未登录 → 302 到登录页');
  res = await req('GET', '/admin');
  ok(res.status === 403, 'GET /admin 未登录 → 403');

  /* 4. 错误密码 */
  let j = jar();
  res = await req('GET', '/login', { cookies: j }); j.apply(res);
  const csrf = j.get('gs_csrf');
  ok(!!csrf, 'HTML 响应注入 gs_csrf cookie');
  res = await req('POST', '/api/login', { cookies: j, csrf, body: { email: 'demo@goship.dev', password: 'wrongpass123' } });
  ok(res.status === 401, '错误密码 → 401');

  /* 5. 正确登录 + 会话 */
  res = await req('POST', '/api/login', { cookies: j, csrf, body: { email: 'demo@goship.dev', password: 'demo123456' } });
  j.apply(res);
  ok(res.status === 200, 'demo 登录 → 200');
  const me = await (await req('GET', '/api/me', { cookies: j })).json();
  ok(me.user && me.user.plan === 'pro', 'GET /api/me 返回已登录用户（pro）');

  /* 6. 项目 CRUD */
  res = await req('POST', '/api/projects', { cookies: j, csrf, body: { name: 'E2E 项目', description: '自动测试' } });
  const created = await res.json();
  ok(res.status === 201 && !!created.project, '创建项目 → 201');
  res = await req('GET', '/api/projects', { cookies: j });
  const list = await res.json();
  ok(Array.isArray(list.projects) && list.projects.some((p) => p.id === created.project.id), '项目列表包含新建项');
  res = await req('DELETE', '/api/projects/' + created.project.id, { cookies: j, csrf });
  ok(res.status === 200, '删除项目 → 200');

  /* 7. CSRF 校验 */
  res = await req('POST', '/api/projects', { cookies: j, body: { name: '无 CSRF' } });
  ok(res.status === 403, '缺少 CSRF 头 → 403');

  /* 8. 注册 / 重复注册 */
  const j2 = jar();
  res = await req('GET', '/register', { cookies: j2 }); j2.apply(res);
  const csrf2 = j2.get('gs_csrf');
  const email = 'e2e-' + Date.now() + '@test.com';
  res = await req('POST', '/api/register', { cookies: j2, csrf: csrf2, body: { email, password: 'password123', name: 'E2E' } });
  ok(res.status === 201, '注册新用户 → 201');
  res = await req('POST', '/api/register', { cookies: j2, csrf: csrf2, body: { email, password: 'password123', name: '重复' } });
  ok(res.status === 409, '重复注册 → 409');
  res = await req('POST', '/api/register', { cookies: j2, csrf: csrf2, body: { email: 'bad@x.com', password: 'short', name: 'x' } });
  ok(res.status === 400, '弱密码 → 400');

  /* 9. 管理后台权限 */
  const j3 = jar();
  res = await req('GET', '/login', { cookies: j3 }); j3.apply(res);
  const csrf3 = j3.get('gs_csrf');
  res = await req('POST', '/api/login', { cookies: j3, csrf: csrf3, body: { email: 'admin@goship.dev', password: 'admin123456' } }); j3.apply(res);
  res = await req('GET', '/api/admin/stats', { cookies: j3 });
  const stats = await res.json();
  ok(res.status === 200 && typeof stats.users === 'number', `管理员看统计 → 200（${stats.users} 用户, ${stats.activeSubscriptions} 订阅）`);
  res = await req('GET', '/api/admin/stats', { cookies: j });
  ok(res.status === 403, '普通用户访问 admin API → 403');

  /* 10. 登出 */
  res = await req('POST', '/api/logout', { cookies: j, csrf });
  ok(res.status === 200, '登出 → 200');
  res = await req('GET', '/api/me', { cookies: j });
  ok(res.status === 401, '登出后 /api/me → 401');

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('测试执行异常：', e); process.exit(1); });
