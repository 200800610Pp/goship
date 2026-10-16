/**
 * test/waffo-signature.test.js — Waffo 验签逻辑单元测试
 * 依据官方实现：X-Waffo-Signature: t=<ts>,v1=<base64>；验签对象 `${t}.${rawBody}`；RSA-SHA256
 * 用法：node test/waffo-signature.test.js
 */
'use strict';

const crypto = require('node:crypto');
const { parseWaffoSignature, verifyWaffoSignature } = require('../src/server.js');

let passed = 0, failed = 0;
const ok = (c, n, extra = '') => { c ? passed++ : failed++; console.log(`  ${c ? '✅' : '❌'} ${n} ${extra}`); };

/* 生成一对测试密钥（模拟 Waffo 的密钥对） */
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function makeSignature(body, ts = Date.now()) {
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${ts}.${body}`);
  sign.end();
  const v1 = sign.sign(privateKey, 'base64');
  return { header: `t=${ts},v1=${v1}`, ts, v1 };
}

console.log('Waffo 验签单元测试：\n');

/* 1. 请求头解析 */
const h = parseWaffoSignature('t=1792074204885,v1=AbC123==');
ok(h && h.t === '1792074204885' && h.v1 === 'AbC123==', '解析 t=...,v1=... 格式');
ok(parseWaffoSignature('') === null, '空请求头 → null');
ok(parseWaffoSignature('garbage') === null, '非法请求头 → null');

/* 2. 正常验签通过 */
const body = JSON.stringify({ id: 'PAY_1', eventType: 'order.completed', data: { buyerEmail: 'a@b.com', chargedAmount: '29.00' } });
const sig = makeSignature(body);
let r = verifyWaffoSignature(body, sig.header, publicKey);
ok(r.ok, `正确签名 → 通过（${r.reason}）`);

/* 3. 请求体被篡改 → 失败 */
const tampered = body.replace('29.00', '2900.00');
r = verifyWaffoSignature(tampered, sig.header, publicKey);
ok(!r.ok && r.reason === 'signature_mismatch', `请求体被篡改 → 拒绝（${r.reason}）`);

/* 4. 用错误公钥 → 失败 */
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
r = verifyWaffoSignature(body, sig.header, other.publicKey);
ok(!r.ok, '错误公钥 → 拒绝');

/* 5. 缺少请求头 → 失败 */
r = verifyWaffoSignature(body, undefined, publicKey);
ok(!r.ok && r.reason === 'header_format', '缺少签名请求头 → 拒绝');

/* 6. 时间戳过旧（重放）→ 失败 */
const oldSig = makeSignature(body, Date.now() - 60 * 60 * 1000); // 1 小时前
r = verifyWaffoSignature(body, oldSig.header, publicKey);
ok(!r.ok && r.reason === 'timestamp_out_of_range', `时间戳超窗（1 小时前）→ 拒绝（${r.reason}）`);

/* 7. 时间戳为"秒"单位也能通过（自动归一化） */
const secSig = makeSignature(body, Math.floor(Date.now() / 1000));
r = verifyWaffoSignature(body, secSig.header, publicKey);
ok(r.ok, '秒级时间戳自动归一化 → 通过');

/* 8. 容忍度设为 0 时跳过时间戳检查 */
const veryOld = makeSignature(body, Date.now() - 24 * 3600 * 1000);
r = verifyWaffoSignature(body, veryOld.header, publicKey, { toleranceMs: 0 });
ok(r.ok, 'toleranceMs=0 → 跳过时间戳检查（用于测试）');

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
