/**
 * util.js — 工具函数集合
 * 限流、请求体解析、Markdown-lite 渲染、HTML 转义、辅助方法
 */
'use strict';

const crypto = require('node:crypto');

/* ---------------- 速率限制（进程内令牌桶） ---------------- */
class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.buckets = new Map();
    // 定期清理，防内存泄漏
    const timer = setInterval(() => this.sweep(), Math.max(windowMs, 60 * 1000));
    timer.unref?.();
  }

  hit(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now - b.startedAt > this.windowMs) {
      b = { startedAt: now, count: 0 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    return b.count <= this.max;
  }

  sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      if (now - b.startedAt > this.windowMs * 2) this.buckets.delete(k);
    }
  }
}

/* ---------------- 请求体解析 ---------------- */
function parseBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        resolve({ error: 'body_too_large' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (req.destroyed) return;
      const buf = Buffer.concat(chunks);
      const type = (req.headers['content-type'] || '').split(';')[0].trim();
      try {
        if (type === 'application/json') {
          resolve({ value: JSON.parse(buf.toString('utf8') || '{}') });
        } else if (type === 'application/x-www-form-urlencoded') {
          const out = {};
          for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) out[k] = v;
          resolve({ value: out });
        } else if (type === 'multipart/form-data') {
          resolve({ error: 'multipart_not_supported' });
        } else {
          resolve({ value: {} });
        }
      } catch {
        resolve({ error: 'invalid_body' });
      }
    });
    req.on('error', () => resolve({ error: 'read_error' }));
  });
}

/* ---------------- 字符串 / 安全 ---------------- */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function uuid() {
  return crypto.randomUUID();
}

function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
}

function clientIp(req, trustProxy = true) {
  const xff = trustProxy ? req.headers['x-forwarded-for'] : null;
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function basicUserAgent(req) {
  return String(req.headers['user-agent'] || '').slice(0, 200);
}

/* ---------------- Markdown-lite 渲染 ----------------
 * 支持：标题/粗体/斜体/行内代码/代码块/链接/图片/列表/引用/分割线/表格(简化)
 * 输出已做 HTML 转义，仅允许受控标签，防 XSS。 */
function renderMarkdown(src) {
  const lines = String(src || '').split(/\r?\n/);
  const out = [];
  let inCode = false, codeBuf = [], inList = false, listType = null, tableBuf = [];

  const flushList = () => {
    if (inList) { out.push(`</${listType}>`); inList = false; listType = null; }
  };
  const isTableRow = (l) => { const t = l.trim(); return t.startsWith('|') && t.endsWith('|'); };
  const isTableSep = (l) => /^\|[\s:|-]+\|$/.test(l.trim());
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.map((r) =>
      r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
    const html = ['<table>'];
    if (rows.length && isTableSep(tableBuf[0])) rows.shift();
    if (rows.length) {
      html.push('<thead><tr>' + rows[0].map((c) => `<th>${c}</th>`).join('') + '</tr></thead>');
      html.push('<tbody>');
      for (let i = 1; i < rows.length; i++) {
        html.push('<tr>' + rows[i].map((c) => `<td>${c}</td>`).join('') + '</tr>');
      }
      html.push('</tbody>');
    }
    html.push('</table>');
    out.push(html.join(''));
    tableBuf = [];
  };
  const inline = (t) => {
    t = escapeHtml(t);
    // 行内代码
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 粗体 / 斜体
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    // 链接
    t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  };

  for (const raw of lines) {
    if (raw.trim().startsWith('```')) {
      if (inCode) { out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>'); codeBuf = []; inCode = false; }
      else { flushList(); flushTable(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    if (isTableRow(raw)) { flushList(); tableBuf.push(raw); continue; }
    if (tableBuf.length) flushTable();

    const line = raw.replace(/\s+$/, '');
    const m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      flushList();
      const lv = m[1].length; // # → h2（页面标题为 h1）
      out.push(`<h${lv + 1} id="${slugify(m[2])}">${inline(m[2])}</h${lv + 1}>`);
      continue;
    }
    if (/^\s*([-*])\s+/.test(line)) {
      if (!inList || listType !== 'ul') { flushList(); inList = true; listType = 'ul'; out.push('<ul>'); }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+[.、)]\s+/.test(line)) {
      if (!inList || listType !== 'ol') { flushList(); inList = true; listType = 'ol'; out.push('<ol>'); }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.、)]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushList(); out.push('<hr/>');
      continue;
    }
    if (!line.trim()) { flushList(); continue; }
    flushList();
    out.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  flushTable();
  return out.join('\n');
}

/* ---------------- HTTP 响应辅助 ---------------- */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function safeStr(v, maxLen = 200) {
  return typeof v === 'string' ? v.slice(0, maxLen) : '';
}

module.exports = {
  RateLimiter, parseBody, escapeHtml, uuid, slugify, clientIp, basicUserAgent,
  renderMarkdown, sendJson, sendText, redirect, safeStr,
};
