#!/usr/bin/env bash
# is6-update [ref]  —— 从多个 CDN 镜像拉取仓库文件，同步更新静态站与计算后端
#
#   is6-update            # 用 main 分支最新
#   is6-update 1327b80    # 固定到某个 commit（推荐：本地测过再推，线上可回滚）
#
# 为什么不用 git pull：这台机器访问 github.com 的 git 协议会被掐（Empty reply）。
# 为什么用多个镜像：jsDelivr 在文件未被缓存时会 302 到 raw.githubusercontent.com，
# 那个域名在国内经常被重置（curl: (35) SSL_ERROR_SYSCALL），所以按顺序回退。
#
# 安装（二选一）：
#   curl -fsSL https://cdn.jsdelivr.net/gh/YUXI-Uho/arkrogue6@main/deploy/is6-update.sh \
#     -o /usr/local/bin/is6-update && chmod +x /usr/local/bin/is6-update
#   或本地：scp .\deploy\is6-update.sh root@<IP>:/usr/local/bin/is6-update
set -uo pipefail

REF="${1:-main}"
WEB="${IS6_WEB_ROOT:-/var/www/is6}"
API="${IS6_API_ROOT:-/opt/is6-api}"

MIRRORS=(
  "https://cdn.jsdelivr.net/gh/YUXI-Uho/arkrogue6@${REF}"
  "https://gcore.jsdelivr.net/gh/YUXI-Uho/arkrogue6@${REF}"
  "https://fastly.jsdelivr.net/gh/YUXI-Uho/arkrogue6@${REF}"
  "https://cdn.statically.io/gh/YUXI-Uho/arkrogue6/${REF}"
  "https://raw.gitmirror.com/YUXI-Uho/arkrogue6/${REF}"
)

STATIC_FILES=(
  index.html 404.html robots.txt manifest.json sw.js LICENSE
  assets/style.css assets/404.css assets/icon.svg
  core/schema.js core/enums.js
  core/db/schema.js core/db/db.js core/db/migrate.js
  core/repos/operators.repo.js core/repos/relics.repo.js core/repos/squads.repo.js
  js/effects.js js/engine.js js/app.js
  data/is6db.js
  deploy/nginx.server.conf deploy/security-headers.conf
)

API_FILES=(
  package.json
  server/index.js server/engine.js server/validate.js
  core/schema.js core/enums.js core/db/schema.js core/db/db.js
  core/repos/operators.repo.js core/repos/relics.repo.js
  js/effects.js js/engine.js
  data/is6db.json
)

# 两份暂存目录与线上目录各在同一文件系统，切换时 mv 只做目录重命名。
# 先收齐文件，任何下载失败都不会碰线上版本。
if [ ! -d "$WEB" ] || [ ! -d "$API" ] || [ -L "$WEB" ] || [ -L "$API" ]; then
  echo "!! 需要已有的网页和 API 实体目录：$WEB / $API" >&2
  exit 1
fi
web_backup="${WEB}.backup.$$"
api_backup="${API}.backup.$$"
if [ -e "$web_backup" ] || [ -e "$api_backup" ]; then
  echo "!! 备份路径已存在，停止发布" >&2
  exit 1
fi
web_stage=''
api_stage=''
committed=0

finish() {
  local rc=$?
  trap - EXIT
  if [ "$committed" -ne 1 ] && { [ -e "$web_backup" ] || [ -e "$api_backup" ]; }; then
    echo "!! 发布失败，恢复上一版" >&2
    if [ -e "$web_backup" ]; then
      if [ -e "$WEB" ]; then mv "$WEB" "${WEB}.failed.$$" || rc=1; fi
      if [ ! -e "$WEB" ]; then mv "$web_backup" "$WEB" || rc=1; fi
    fi
    if [ -e "$api_backup" ]; then
      if [ -e "$API" ]; then mv "$API" "${API}.failed.$$" || rc=1; fi
      if [ ! -e "$API" ]; then mv "$api_backup" "$API" || rc=1; fi
    fi
    systemctl restart is6-api || rc=1
    nginx -t && systemctl reload nginx || rc=1
  fi
  if [ -n "$web_stage" ] && [ -d "$web_stage" ]; then rm -rf -- "$web_stage"; fi
  if [ -n "$api_stage" ] && [ -d "$api_stage" ]; then rm -rf -- "$api_stage"; fi
  exit "$rc"
}
trap finish EXIT
web_stage=$(mktemp -d "${WEB}.stage.XXXXXXXX") || exit 1
api_stage=$(mktemp -d "${API}.stage.XXXXXXXX") || exit 1

# fetch <相对路径> <暂存文件>：逐个镜像试，成功返回 0
fetch() {
  local rel="$1" dst="$2" tmp="${2}.part" m
  mkdir -p "$(dirname "$dst")"
  for m in "${MIRRORS[@]}"; do
    if curl -fsSL --connect-timeout 8 --max-time 60 --retry 1 "$m/$rel" -o "$tmp" 2>/dev/null \
       && [ -s "$tmp" ] && [ "$(wc -c < "$tmp")" -gt 64 ]; then
      mv -f "$tmp" "$dst"
      return 0
    fi
  done
  rm -f "$tmp"
  return 1
}

echo "==> ref: $REF"
fail=0

for f in "${STATIC_FILES[@]}"; do
  if ! fetch "$f" "$web_stage/$f"; then echo "    FAIL web/$f"; fail=1; fi
done
for f in "${API_FILES[@]}"; do
  if ! fetch "$f" "$api_stage/$f"; then echo "    FAIL api/$f"; fail=1; fi
done

if [ "$fail" -ne 0 ]; then
  echo "!! 有文件没拉到（网络问题），已中止。现有文件保持原样，可稍后重试。"
  echo "!! 如果一直失败：在本地用 pack-and-ship.ps1 / ship-api.ps1 直接上传。"
  exit 1
fi

chown -R nginx:nginx "$web_stage" || exit 1
chown -R is6:is6 "$api_stage" || exit 1
nginx -t || exit 1
node -e 'require(process.argv[1])' "$api_stage/server/engine.js" || exit 1

mv "$WEB" "$web_backup" || exit 1
mv "$web_stage" "$WEB" || exit 1
mv "$API" "$api_backup" || exit 1
mv "$api_stage" "$API" || exit 1

nginx -t && systemctl reload nginx || exit 1
systemctl restart is6-api || exit 1

echo "--- 自检 ---"
curl -fsS --retry 5 --retry-delay 1 -o /dev/null -w "web  %{http_code}\n" http://127.0.0.1/ || exit 1
curl -fsS --retry 5 --retry-delay 1 -o /dev/null -w "api  %{http_code}\n" http://127.0.0.1/api/meta || exit 1
systemctl is-active --quiet is6-api || exit 1
committed=1
echo "==> 发布成功；上一版备份：$web_backup / $api_backup"
