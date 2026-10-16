/**
 * test/profile.test.js — 资料修改（昵称/密码）独立验证
 * 用法：先启动服务器，再 node test/profile.test.js
 */
'use strict';

const BASE = process.env.TEST_BASE || 'http://127.0.0.1:8787';
let passed = 0, failed = 0;
const ok = (c, n) => { c ? passed++ : failed++; console.log(`  ${c ? '✅' : '❌'} ${n}`); };

function jar() {
  const m = new Map();
  return {
    apply(r) {
      const sc = r.headers.get('set-cookie');
      if (sc) { const [p] = sc.split(';'); const i = p.indexOf('='); m.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); }
    },
    h() { return [...m].map(([k, v]) => `${k}=${v}`).join('; '); },
    get(n) { return m.get(n); },
  };
}
async function req(method, path, { cookies, csrf, body } = {}) {
  const headers = {};
  if (cookies) headers.cookie = cookies.h();
  if (csrf != null) headers['x-csrf-token'] = csrf;
  if (body != null) headers['content-type'] = 'application/json';
  return fetch(BASE + path, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
}

async function main() {
  console.log('资料修改流程测试：\n');
  const j = jar();
  let r = await req('GET', '/login', { cookies: j }); j.apply(r);
  const csrf = j.get('gs_csrf');
  r = await req('POST', '/api/login', { cookies: j, csrf, body: { email: 'demo@goship.dev', password: 'demo123456' } }); j.apply(r);
  ok(r.status === 200, '登录 demo');
  r = await req('POST', '/api/profile', { cookies: j, csrf, body: { name: '改名测试', password: 'newpassword123' } });
  ok(r.status === 200, '修改昵称+密码');
  r = await req('POST', '/api/logout', { cookies: j, csrf });
  ok(r.status === 200, '登出');
  r = await req('POST', '/api/login', { cookies: j, csrf, body: { email: 'demo@goship.dev', password: 'demo123456' } });
  ok(r.status === 401, '旧密码失效（401）');
  r = await req('POST', '/api/login', { cookies: j, csrf, body: { email: 'demo@goship.dev', password: 'newpassword123' } }); j.apply(r);
  ok(r.status === 200, '新密码登录成功');
  r = await req('POST', '/api/profile', { cookies: j, csrf, body: { password: 'demo123456' } });
  ok(r.status === 200, '恢复原密码（清理现场）');
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
