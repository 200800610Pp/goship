/**
 * auth.js — 零依赖认证
 * 密码：node:crypto scrypt（OWASP 推荐 KDF，无需 bcrypt 依赖）
 * 会话：随机 token + HMAC-SHA256 签名 cookie；服务端只存 token 哈希，防库泄露回放
 */
'use strict';

const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** 密码哈希：格式 scrypt$N$r$p$saltHex$hashHex */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** 校验密码（timingSafeEqual 防时序攻击） */
function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltHex, hashHex] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = crypto.scryptSync(String(password), salt, expected.length, {
      N: parseInt(N, 10), r: parseInt(r, 10), p: parseInt(p, 10),
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** 生成随机会话 token（返回明文，服务端存哈希） */
function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** HMAC 签名（cookie 防篡改） */
function sign(value, secret) {
  const h = crypto.createHmac('sha256', secret).update(String(value)).digest('base64url');
  return `${value}.${h}`;
}

function unsign(signed, secret) {
  const idx = String(signed).lastIndexOf('.');
  if (idx === -1) return null;
  const value = String(signed).slice(0, idx);
  const h = String(signed).slice(idx + 1);
  const expect = crypto.createHmac('sha256', secret).update(value).digest('base64url');
  const a = Buffer.from(h), b = Buffer.from(expect);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? value : null;
}

/** 解析 Cookie 头 → {name: value} */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`); else parts.push('Path=/');
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`); else parts.push('SameSite=Lax');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 校验邮箱格式（宽松但防明显垃圾输入） */
function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

module.exports = {
  hashPassword, verifyPassword, newSessionToken, hashToken,
  sign, unsign, parseCookies, serializeCookie, isValidEmail,
};
