#!/usr/bin/env bash
# GoShip 每日备份脚本（配合 crontab）
# crontab -e 添加：0 3 * * * /opt/goship/deploy/backup.sh
set -euo pipefail

BACKUP_DIR="/opt/goship-backups"
DB_FILE="/opt/goship/data/db.json"
KEEP=14

mkdir -p "${BACKUP_DIR}"
STAMP=$(date +%Y%m%d-%H%M%S)
cp "${DB_FILE}" "${BACKUP_DIR}/db-${STAMP}.json"
gzip "${BACKUP_DIR}/db-${STAMP}.json"

# 只保留最近 14 份
ls -t "${BACKUP_DIR}"/db-*.json.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "[backup] ok: db-${STAMP}.json.gz"
# 建议：将 BACKUP_DIR 目录接入对象存储/网盘自动同步（如 rclone）
