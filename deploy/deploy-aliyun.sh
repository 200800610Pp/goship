#!/usr/bin/env bash
# GoShip 轻量服务器一键部署（支持 Ubuntu / Debian / Rocky / CentOS / AlmaLinux）
# 用法：以 root 执行  bash deploy/deploy-aliyun.sh
# 说明：可从任意目录执行，脚本会自动定位项目根目录
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"
APP_NAME="goship"
APP_DIR="/opt/goship"
PORT="${PORT:-8787}"

echo "==> 1/4 安装 Node.js 运行时"
if ! command -v node >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then          # Ubuntu / Debian
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y nodejs >/dev/null
  elif command -v dnf >/dev/null 2>&1; then             # Rocky / AlmaLinux / 新版 CentOS
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
    dnf install -y nodejs >/dev/null
  elif command -v yum >/dev/null 2>&1; then             # 老版 CentOS
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
    yum install -y nodejs >/dev/null
  else
    echo "❌ 未识别的系统，请手动安装 Node.js 20 后重跑本脚本"; exit 1
  fi
fi
node --version

echo "==> 2/4 部署应用文件（${PROJECT_DIR} → ${APP_DIR}）"
mkdir -p "${APP_DIR}"
# 同步项目文件（排除 data 目录，避免覆盖线上数据）
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude 'data/' --exclude '.git/' --exclude 'node_modules/' --exclude '.env' \
    "${PROJECT_DIR}/" "${APP_DIR}/"
else
  cp -r "${PROJECT_DIR}/src" "${PROJECT_DIR}/content" "${PROJECT_DIR}/package.json" "${APP_DIR}/"
fi

# 生成会话密钥（不覆盖已有配置）
touch "${APP_DIR}/.env"
if ! grep -q "SESSION_SECRET" "${APP_DIR}/.env"; then
  echo "SESSION_SECRET=$(openssl rand -hex 32)" >> "${APP_DIR}/.env"
fi
if ! grep -q "GOSHIP_MODE" "${APP_DIR}/.env"; then
  echo "GOSHIP_MODE=production" >> "${APP_DIR}/.env"
fi
if ! grep -q "SITE_URL" "${APP_DIR}/.env"; then
  echo "SITE_URL=http://$(hostname -I | awk '{print $1}'):${PORT}" >> "${APP_DIR}/.env"
fi

echo "==> 3/4 配置 systemd 服务"
cat > /etc/systemd/system/${APP_NAME}.service <<EOF
[Unit]
Description=GoShip SaaS Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node ${APP_DIR}/src/server.js
Restart=always
RestartSec=3
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${APP_NAME}" >/dev/null
systemctl restart "${APP_NAME}"

echo "==> 4/4 完成"
sleep 1
systemctl --no-pager status "${APP_NAME}" | head -n 5
echo ""
echo "✅ 部署完成：http://$(hostname -I | awk '{print $1}'):${PORT}"
echo "   查看日志: journalctl -u ${APP_NAME} -f"
echo "   下一步:   绑定域名 + Caddy 自动 HTTPS:"
echo "             caddy reverse-proxy --from yourdomain.com --to 127.0.0.1:${PORT}"
