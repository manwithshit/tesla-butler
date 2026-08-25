#!/bin/bash

set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

MODE="preflight"
OUTPUT_DIR="$HOME/Desktop"
CUTOVER_STOPPED=0
EXPORT_OK=0
STAGING=""
LARK_PROFILE_JSON=""

usage() {
  echo "用法：$0 [--mode preflight|cutover] [--output 目录]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$MODE" != "preflight" ] && [ "$MODE" != "cutover" ]; then
  echo "--mode 只能是 preflight 或 cutover。" >&2
  exit 2
fi

cleanup() {
  local code=$?
  if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then
    rm -rf "$STAGING"
  fi
  unset MIGRATION_PASSPHRASE || true
  unset LARK_PROFILE_JSON || true
  if [ "$code" -ne 0 ] && [ "$CUTOVER_STOPPED" -eq 1 ] && [ "$EXPORT_OK" -eq 0 ]; then
    echo "最终导出失败，正在恢复 M5 采集服务。" >&2
    compose up -d teslamate >/dev/null 2>&1 || true
    start_installed_worker >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

require_command docker
require_command openssl
require_command shasum
require_command tar

if [ "$MODE" = "cutover" ]; then
  require_command jq
  require_command lark-cli
  LARK_PROFILE_JSON="$(lark-cli --profile tesla-saving-ticket config show 2>/dev/null)"
  if ! printf '%s' "$LARK_PROFILE_JSON" | jq -e '
    .appId | type == "string" and length > 0
  ' >/dev/null || ! printf '%s' "$LARK_PROFILE_JSON" | jq -e '
    .appSecret | type == "string" and length > 0
  ' >/dev/null; then
    echo "无法安全读取 M5 的 tesla-saving-ticket 飞书 profile。" >&2
    exit 1
  fi
fi

if [ ! -f "$PROJECT_ROOT/infra/teslamate/.env" ]; then
  echo "找不到 TeslaMate .env。" >&2
  exit 1
fi

if ! compose ps --status running database | grep -q database; then
  echo "TeslaMate PostgreSQL 当前未运行。" >&2
  exit 1
fi

read_new_passphrase
mkdir -p "$OUTPUT_DIR"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/tesla-saving-ticket-migration.XXXXXX")"
chmod 700 "$STAGING"
mkdir -p "$STAGING/infra/teslamate" "$STAGING/data/processed" "$STAGING/data/raw" "$STAGING/credentials"

if [ "$MODE" = "cutover" ]; then
  printf '%s' "$LARK_PROFILE_JSON" | jq -c '{
    profile: "tesla-saving-ticket",
    app_id: .appId,
    app_secret: .appSecret,
    brand: (.brand // "feishu"),
    lang: (.lang // "zh_cn")
  }' > "$STAGING/credentials/feishu-profile.json"
  chmod 600 "$STAGING/credentials/feishu-profile.json"
  unset LARK_PROFILE_JSON

  echo "正在停止 M5 的飞书 Worker 与 TeslaMate 采集器。"
  stop_worker
  compose stop teslamate >/dev/null
  CUTOVER_STOPPED=1
fi

compose exec -T database pg_dump -U teslamate -d teslamate -Fc > "$STAGING/teslamate.dump"
cp "$PROJECT_ROOT/infra/teslamate/.env" "$STAGING/infra/teslamate/.env"
chmod 600 "$STAGING/infra/teslamate/.env" "$STAGING/teslamate.dump"

for name in receipts.json runtime-state.json reference-fuel-prices.json; do
  if [ -f "$PROJECT_ROOT/data/processed/$name" ]; then
    cp "$PROJECT_ROOT/data/processed/$name" "$STAGING/data/processed/$name"
  fi
done
if [ -d "$PROJECT_ROOT/data/raw/feishu" ]; then
  cp -R "$PROJECT_ROOT/data/raw/feishu" "$STAGING/data/raw/feishu"
fi

COUNTS="$(database_counts)"
DRIVES="${COUNTS%%|*}"
REST="${COUNTS#*|}"
POSITIONS="${REST%%|*}"
CHARGES="${REST##*|}"
EXPORTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' \
  "format_version=1" \
  "export_mode=$MODE" \
  "exported_at_utc=$EXPORTED_AT" \
  "drives=$DRIVES" \
  "positions=$POSITIONS" \
  "charging_processes=$CHARGES" \
  > "$STAGING/MANIFEST.txt"

(
  cd "$STAGING"
  find . -type f ! -name FILES.sha256 -print | LC_ALL=C sort | while IFS= read -r file; do
    shasum -a 256 "$file"
  done > FILES.sha256
)

STAMP="$(date +%Y%m%d-%H%M%S)"
BUNDLE="$OUTPUT_DIR/tesla-saving-ticket-m5-$MODE-$STAMP.tar.enc"
tar -C "$STAGING" -cf - . | openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -pass env:MIGRATION_PASSPHRASE -out "$BUNDLE"
chmod 600 "$BUNDLE"
shasum -a 256 "$BUNDLE" > "$BUNDLE.sha256"
chmod 600 "$BUNDLE.sha256"
EXPORT_OK=1

echo "已生成加密迁移包：$BUNDLE"
echo "数据库基线：drives=$DRIVES，positions=$POSITIONS，charging_processes=$CHARGES"
if [ "$MODE" = "preflight" ]; then
  echo "M5 服务未停止；此包仅用于 M1 预验证，不能作为最终切换包。"
else
  echo "M5 采集与飞书 Worker 已停止；特斯拉飞书 profile 仅存在于加密包内。请在 M1 完成最终导入后再恢复服务。"
fi
