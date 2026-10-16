/**
 * db.js — 零依赖 JSON 数据库
 * 特性：进程内缓存 + 原子写入（临时文件 + rename），断电不损坏数据文件。
 * 适用于单机/轻量场景（<10万条记录），也正是 GoShip 的目标部署形态。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

class JsonDb {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.cache = null;
    this.writeQueue = Promise.resolve();
  }

  /** 加载（或初始化）数据库 */
  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, 'utf8');
        this.cache = JSON.parse(raw);
        if (!this.cache || typeof this.cache !== 'object') this.cache = this.empty();
      } catch (e) {
        console.error('[db] 数据文件损坏，创建备份并重置：', e.message);
        try { fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now()); } catch {}
        this.cache = this.empty();
        this.persistSync();
      }
    } else {
      this.cache = this.empty();
      this.persistSync();
    }
    return this;
  }

  empty() {
    return {
      meta: { version: 1, createdAt: new Date().toISOString() },
      users: [],           // {id,email,passHash,salt,name,role,plan,createdAt,lastLoginAt,emailVerified}
      sessions: [],        // {tokenHash,userId,expiresAt,createdAt,userAgent}
      projects: [],        // 示例业务实体
      subscriptions: [],   // {id,userId,plan,status,provider,amount,startedAt,expiresAt,externalId}
      payments: [],        // {id,provider,event,payload,createdAt}
      posts: [],           // 博客（从 content/posts 加载）
      settings: {
        siteName: 'GoShip',
        siteNameZh: '出海快启',
        allowRegister: true,
        demoBanner: true,
        plans: [],
      },
      events: [],          // 埋点/分析事件
    };
  }

  /** 原子持久化（串行队列防并发写坏） */
  persist() {
    const snapshot = JSON.stringify(this.cache, null, 2);
    this.writeQueue = this.writeQueue.then(() => {
      const tmp = this.file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, snapshot, 'utf8');
      fs.renameSync(tmp, this.file);
    }).catch((e) => console.error('[db] 写入失败：', e.message));
    return this.writeQueue;
  }

  persistSync() {
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2), 'utf8');
  }

  /** 集合快捷访问 */
  col(name) {
    return this.cache[name] || (this.cache[name] = []);
  }

  insert(name, doc) {
    const col = this.col(name);
    col.push(doc);
    this.persist();
    return doc;
  }

  findOne(name, predicate) {
    return this.col(name).find(predicate) || null;
  }

  find(name, predicate) {
    return this.col(name).filter(predicate);
  }

  update(name, predicate, patch) {
    const doc = this.col(name).find(predicate);
    if (!doc) return null;
    Object.assign(doc, patch);
    this.persist();
    return doc;
  }

  remove(name, predicate) {
    const col = this.col(name);
    const i = col.findIndex(predicate);
    if (i === -1) return false;
    col.splice(i, 1);
    this.persist();
    return true;
  }

  setSetting(key, value) {
    this.cache.settings[key] = value;
    this.persist();
  }

  /** 持久化内存缓存（进程退出时调用） */
  flushSync() {
    this.persistSync();
  }
}

module.exports = { JsonDb };
