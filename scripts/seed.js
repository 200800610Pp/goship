/**
 * seed.js — 重置为演示数据（删除 data/ 目录后由服务器自动重建）
 * 用法：node scripts/seed.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.resolve(__dirname, '..', 'data');
if (fs.existsSync(dataDir)) {
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('[seed] 已清空 data/，下次启动将自动重建演示数据');
} else {
  console.log('[seed] data/ 不存在，无需清理');
}
