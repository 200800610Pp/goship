/**
 * GoShip 配置
 * 所有配置项均可通过环境变量覆盖（或放入 .env，由 envFile 简易解析读取）。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// 极简 .env 解析（KEY=VALUE / KEY="VALUE" / # 注释），零依赖
function loadEnv(file) {
  const out = {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const key = t.slice(0, i).trim();
      let val = t.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) out[key] = val;
    }
  } catch { /* 无 .env 文件时静默跳过 */ }
  return out;
}

const env = Object.assign({}, loadEnv(path.join(__dirname, '..', '.env')), process.env);

/** 读取文本文件（用于存放 Waffo 公钥等） */
function readTextFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * 收集所有可用的 Waffo 公钥（测试 + 生产）。
 * Waffo 的测试与生产使用不同密钥对，任一验签通过即视为合法通知，
 * 因此这里同时加载两把，避免环境切换时漏收通知。
 */
function buildWaffoPublicKeys(e) {
  const list = [
    e.WAFFO_PUBLIC_KEY,
    e.WAFFO_PUBLIC_KEY_PROD,
    readTextFile(path.resolve(__dirname, '..', 'data', 'waffo-public.pem')),
    readTextFile(path.resolve(__dirname, '..', 'data', 'waffo-public-prod.pem')),
  ];
  return list
    .map((k) => String(k || '').replace(/\\n/g, '\n').trim())
    .filter(Boolean);
}

const WAFFO_PUBLIC_KEYS = buildWaffoPublicKeys(env);

const SITE = {
  name: 'GoShip',
  nameZh: '出海快启',
  tagline: '为中国独立开发者打造的零依赖出海 SaaS 启动套件',
  taglineEn: 'Zero-dependency SaaS starter kit for Chinese indie founders going global',
  url: env.SITE_URL || 'http://localhost:8787',
  supportEmail: env.SUPPORT_EMAIL || '167536085@qq.com',
  founderName: env.FOUNDER_NAME || 'GoShip 创始人',
  twitter: env.TWITTER || '@goship_cn',
};

module.exports = {
  SITE,
  port: parseInt(env.PORT || '8787', 10),
  host: env.HOST || '127.0.0.1',
  mode: env.GOSHIP_MODE || 'demo', // demo | production
  dataDir: path.resolve(__dirname, '..', env.DATA_DIR || 'data'),
  contentDir: path.resolve(__dirname, '..', env.CONTENT_DIR || 'content'),
  publicDir: path.resolve(__dirname, 'public'),
  sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionTtlMs: 7 * 24 * 3600 * 1000, // 会话 7 天
  paymentWebhookSecret: env.PAYMENT_WEBHOOK_SECRET || '',
  // Waffo 收款平台公钥（用于 Webhook RSA 验签）：测试 + 生产两把同时生效
  waffoPublicKeys: WAFFO_PUBLIC_KEYS,
  waffoPublicKey: WAFFO_PUBLIC_KEYS[0] || '', // 兼容旧引用
  // Webhook 验签的时间戳容差（防重放）。
  // 注意：Waffo 重试时会沿用最初的时间戳，重试窗口最长约 8 小时，
  // 因此窗口必须覆盖重试周期，否则迟到的重试会被误拒。默认 24 小时；设为 0 可关闭。
  sigToleranceMs: parseInt(env.WAFFO_SIG_TOLERANCE_MS || String(24 * 60 * 60 * 1000), 10),
  inviteCode: env.INVITE_CODE || '', // 非空则注册需要邀请码（灰度发布用）
  limits: {
    bodyMaxBytes: 1 * 1024 * 1024, // 请求体上限 1MB
    // 每 IP 每分钟请求上限（可用 RATE_LIMIT_MAX 环境变量调整）
    rate: { windowMs: 60 * 1000, max: parseInt(env.RATE_LIMIT_MAX || '120', 10) },
    authRate: { windowMs: 10 * 60 * 1000, max: 20 }, // 登录/注册接口更严格
  },
};
