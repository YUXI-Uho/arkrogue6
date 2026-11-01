#!/usr/bin/env bash
# is6-update [ref]  —— 从 jsDelivr 拉取仓库文件，同步更新静态站与计算后端
#
#   is6-update            # 用 main 分支最新
#   is6-update 1ceed8b    # 固定到某个 commit（推荐：本地测过再推，线上可回滚）
#
# 为什么不用 git pull：这台机器访问 github.com 的 git 协议会被掐（Empty reply），
# 但 jsDelivr 是 GitHub 的 CDN，国内可达。
#
# 安装：
#   curl -fsSL https://cdn.jsdelivr.net/gh/YUXI-Uho/arkrogue6@main/deploy/is6-update.sh \
#     -o /usr/local/bin/is6-update && chmod +x /usr/local/bin/is6-update
set -euo pipefail

REF="${1:-main}"
BASE="https://cdn.jsdelivr.net/gh/YUXI-Uho/arkrogue6@${REF}"
WEB=/var/www/is6
API=/opt/is6-api

STATIC_FILES=(
  index.html 404.html robots.txt manifest.json sw.js LICENSE
  assets/style.css assets/404.css assets/icon.svg
  core/schema.js core/enums.js
  core/db/schema.js core/db/db.js core/db/migrate.js
  core/repos/operators.repo.js core/repos/relics.repo.js core/repos/squads.repo.js
  js/effects.js js/engine.js js/app.js
  data/is6db.js
)

API_FILES=(
  package.json
  server/index.js server/engine.js server/validate.js
  core/schema.js core/enums.js core/db/schema.js core/db/db.js
  core/repos/operators.repo.js core/repos/relics.repo.js
  js/effects.js js/engine.js
  data/is6db.json
)

echo "==> source: $BASE"
fail=0

for f in "${STATIC_FILES[@]}"; do
  mkdir -p "$WEB/$(dirname "$f")"
  if curl -fsSL "$BASE/$f" -o "$WEB/$f"; then :; else echo "    FAIL web/$f"; fail=1; fi
done

for f in "${API_FILES[@]}"; do
  mkdir -p "$API/$(dirname "$f")"
  if curl -fsSL "$BASE/$f" -o "$API/$f"; then :; else echo "    FAIL api/$f"; fail=1; fi
done

if [ "$fail" -ne 0 ]; then
  echo "!! 有文件拉取失败，已中止（现有文件未被删除，可重试）"
  exit 1
fi

chown -R nginx:nginx "$WEB"
chown -R is6:is6 "$API"

nginx -t
systemctl reload nginx
systemctl restart is6-api
sleep 1

echo "--- 自检 ---"
curl -s -o /dev/null -w "web  %{http_code}\n" http://127.0.0.1/
curl -s -o /dev/null -w "raw  %{http_code}\n" http://127.0.0.1/raw/character_table.json
curl -s http://127.0.0.1/api/meta | head -c 160
echo
