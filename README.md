# GoShip（出海快启）

> 为中国独立开发者打造的**零依赖出海 SaaS 快速启动套件**。
> 无构建步骤、无框架锁定、无 npm 依赖 —— 一条命令在任意 VPS / 轻量服务器上跑起来。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](#)

## 为什么是 GoShip

- **零依赖**：仅使用 Node.js 内置模块（`node:http` / `node:crypto` / `node:fs`），生产环境无需 `npm install`。
- **开箱即用**：着陆页、定价页、邮箱注册/登录、会话管理、CSRF 防护、速率限制、JSON 数据库、管理后台、博客、文档站点 —— 全部内置。
- **出海就绪**：内置 Waffo Pancake 支付接入层与 Webhook 验签骨架（RSA-SHA256），双语（中/英）着陆页。
- **部署自由**：阿里云 / 腾讯云轻量服务器、任意 VPS、Docker 一条命令部署。

## 快速开始

```bash
# 1. 启动（默认端口 8787）
node src/server.js

# 2. 打开浏览器
#    着陆页:   http://localhost:8787
#    管理后台: http://localhost:8787/admin
#    初始账号: admin@goship.dev / admin123456  （请立即修改）
```

Windows 用户：双击 `start.bat`，或在 PowerShell 执行 `node src\server.js`。

## 目录结构

```
goship/
├── src/
│   ├── server.js          # 入口：HTTP 服务器 + 路由 + 中间件
│   ├── config.js          # 配置（端口、密钥、站点信息）
│   ├── lib/
│   │   ├── db.js          # 零依赖 JSON 数据库（原子写入）
│   │   ├── auth.js        # scrypt 密码哈希 + HMAC 签名会话
│   │   └── util.js        # 工具函数（限流、解析、渲染）
│   └── public/            # 前端（原生 HTML/CSS/JS，无构建步骤）
├── content/
│   ├── posts/             # 博客文章（JSON + Markdown-lite）
│   └── docs/              # 文档页
├── data/                  # 运行时数据库文件（自动创建）
├── deploy/                # Docker / nginx / 云服务器部署脚本
└── docs-zh/               # 使用文档
```

## 环境变量（`.env`，可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `SESSION_SECRET` | 随机生成 | 会话签名密钥（生产环境必须设置） |
| `DATA_DIR` | `./data` | 数据库目录 |
| `GOSHIP_MODE` | `demo` | `demo` / `production`（production 关闭演示数据） |

## 支付接入（出海变现）

收款平台：**Waffo Pancake** —— 费率约 3.9% + $0.5/笔；个人可注册、无需公司主体；提现到支付宝/银行卡（人民币结算）；有完整中文文档。

1. 在 [Waffo Pancake](https://waffo.ai) 创建商品：专业版 $29 / 团队版 $139（一次性买断）、更新订阅 $14/年（订阅）；
2. 将商品支付链接填入 `src/public/assets/app.js` 的 `GOSHIP.payments.proUrl / teamUrl`；
3. 配置 Webhook 指向 `https://getgoship.com/api/payments/webhook`，勾选事件 `order.completed` / `subscription.activated` / `subscription.canceled` / `refund.succeeded`；
4. 下载 Waffo 公钥保存为 `data/waffo-public.pem` —— 服务端用它校验 `X-Waffo-Signature`（`t=<时间戳>,v1=<Base64签名>`，RSA-SHA256，验签内容为 `${时间戳}.${原始请求体}`）；
5. 购买成功 → 系统自动开通订阅（`data/db.json` 中的 `subscriptions` 表）。

详细说明见网站文档：https://getgoship.com/docs/payments

## 许可

[MIT](LICENSE) —— 买断制：购买专业版可商用并获取终身更新；详见定价页。
