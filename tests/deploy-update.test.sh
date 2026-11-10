#!/usr/bin/env bash
# 隔离测试 is6-update 的下载失败、健康检查失败和成功切换。
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/deploy/is6-update.sh"
TEST_ROOT=$(mktemp -d)
TEST_ROOT=$(cd "$TEST_ROOT" && pwd -P)
case "$TEST_ROOT" in /tmp/tmp.*) ;; *) echo 'Unexpected test directory' >&2; exit 1 ;; esac
trap 'rm -rf -- "$TEST_ROOT"' EXIT

curl() {
  local dst='' url='' arg previous=''
  for arg in "$@"; do
    if [ "$previous" = '-o' ]; then dst="$arg"; fi
    case "$arg" in http*) url="$arg" ;; esac
    previous="$arg"
  done
  if [[ "$url" == http://127.0.0.1/* ]]; then
    [ "${MOCK_HEALTH_FAIL:-0}" != 1 ]
    return
  fi
  if [[ "$url" == */server/validate.js && "${MOCK_FETCH_FAIL:-0}" == 1 ]]; then return 1; fi
  printf '%080d' 1 > "$dst"
}
chown() { return 0; }
nginx() { return 0; }
node() { return 0; }
systemctl() {
  if [ "$1" = restart ] && [ "${MOCK_RESTART_FAIL:-0}" = 1 ]; then return 1; fi
  if [ "$1" = reload ] && [ "${MOCK_RELOAD_FAIL:-0}" = 1 ]; then return 1; fi
  return 0
}
export -f curl chown nginx node systemctl

run_case() {
  local label="$1" expect="$2" actual=0
  local case_root="$TEST_ROOT/$label"
  export IS6_WEB_ROOT="$case_root/web" IS6_API_ROOT="$case_root/api"
  mkdir -p "$IS6_WEB_ROOT" "$IS6_API_ROOT"
  printf 'old-web' > "$IS6_WEB_ROOT/version"
  printf 'old-api' > "$IS6_API_ROOT/version"
  bash "$SCRIPT" test-ref > "$case_root/output" 2>&1 || actual=$?
  if [ "$expect" = success ]; then
    [ "$actual" -eq 0 ] || { printf 'FAIL %s: exit %s\n' "$label" "$actual"; return 1; }
    [ ! -e "$IS6_WEB_ROOT/version" ] && [ ! -e "$IS6_API_ROOT/version" ] || return 1
    [ -s "$IS6_WEB_ROOT/index.html" ] && [ -s "$IS6_API_ROOT/server/index.js" ] || return 1
  else
    [ "$actual" -ne 0 ] || { printf 'FAIL %s: expected failure\n' "$label"; return 1; }
    [ "$(cat "$IS6_WEB_ROOT/version")" = old-web ] || return 1
    [ "$(cat "$IS6_API_ROOT/version")" = old-api ] || return 1
  fi
  printf 'PASS %s\n' "$label"
}

export MOCK_FETCH_FAIL=1
run_case fetch-failure failure
unset MOCK_FETCH_FAIL
export MOCK_RELOAD_FAIL=1
run_case reload-failure failure
unset MOCK_RELOAD_FAIL
export MOCK_RESTART_FAIL=1
run_case restart-failure failure
unset MOCK_RESTART_FAIL
export MOCK_HEALTH_FAIL=1
run_case health-failure failure
unset MOCK_HEALTH_FAIL
run_case success success
