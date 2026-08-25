#!/bin/bash

set -Eeuo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

MODE="preflight"
BUNDLE=""
REPLACE_TARGET=0
SOURCE_M5_STOPPED=0
STAGING=""
CURRENT_STAGE="参数校验"

report_error() {
  local code=$?
  echo "M1 导入失败：阶段=${CURRENT_STAGE}，行号=${BASH_LINENO[0]}，退出码=${code}。" >&2
  return "$code"
}

usage() {
  echo "用法：$0 --bundle 文件 --replace-target-db [--mode preflight|cutover] [--source-m5-stopped]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle)
      BUNDLE="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --replace-target-db)
      REPLACE_TARGET=1
      shift
      ;;
    --source-m5-stopped)
      SOURCE_M5_STOPPED=1
      shift
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

if [ -z "$BUNDLE" ] || [ ! -f "$BUNDLE" ]; then
  echo "迁移包不存在。" >&2
  usage >&2
  exit 2
fi
if [ "$REPLACE_TARGET" -ne 1 ]; then
  echo "导入会删除 M1 当前项目的 Docker 数据卷；必须显式提供 --replace-target-db。" >&2
  exit 2
fi
if [ "$MODE" != "preflight" ] && [ "$MODE" != "cutover" ]; then
  echo "--mode 只能是 preflight 或 cutover。" >&2
  exit 2
fi
if [ "$MODE" = "cutover" ] && [ "$SOURCE_M5_STOPPED" -ne 1 ]; then
  echo "最终切换前必须确认 M5 TeslaMate 和飞书 Worker 已停止，并提供 --source-m5-stopped。" >&2
  exit 2
fi

cleanup() {
  local code=$?
  if [ -n "$STAGING" ] && [ -d "$STAGING" ]; then
    rm -rf "$STAGING"
  fi
  unset MIGRATION_PASSPHRASE || true
  unset LARK_APP_ID LARK_APP_SECRET LARK_BRAND LARK_LANG || true
  exit "$code"
}
trap report_error ERR
trap cleanup EXIT INT TERM

CURRENT_STAGE="依赖检查"
require_command docker
require_command openssl
require_command shasum
require_command tar
if [ "$MODE" = "cutover" ]; then
  require_command jq
  require_command lark-cli
fi

CURRENT_STAGE="迁移包校验"
if [ -f "$BUNDLE.sha256" ]; then
  (cd "$(dirname "$BUNDLE")" && shasum -a 256 -c "$(basename "$BUNDLE.sha256")")
fi

CURRENT_STAGE="迁移包解密"
read_passphrase
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/tesla-saving-ticket-import.XXXXXX")"
chmod 700 "$STAGING"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:MIGRATION_PASSPHRASE \
  -in "$BUNDLE" | tar -xf - -C "$STAGING"

(
  cd "$STAGING"
  shasum -a 256 -c FILES.sha256
)

for required in MANIFEST.txt teslamate.dump infra/teslamate/.env; do
  if [ ! -f "$STAGING/$required" ]; then
    echo "迁移包缺少：$required" >&2
    exit 1
  fi
done

EXPORT_MODE="$(awk -F= '$1 == "export_mode" {print $2}' "$STAGING/MANIFEST.txt")"
if [ "$MODE" = "cutover" ] && [ "$EXPORT_MODE" != "cutover" ]; then
  echo "最终切换只能导入 cutover 模式生成的迁移包。" >&2
  exit 1
fi

CURRENT_STAGE="飞书 profile 迁移"
if [ "$MODE" = "cutover" ]; then
  if [ ! -f "$STAGING/credentials/feishu-profile.json" ]; then
    echo "最终迁移包缺少加密的飞书 profile。" >&2
    exit 1
  fi
  LARK_APP_ID="$(jq -er '.app_id | select(type == "string" and length > 0)' "$STAGING/credentials/feishu-profile.json")"
  LARK_APP_SECRET="$(jq -er '.app_secret | select(type == "string" and length > 0)' "$STAGING/credentials/feishu-profile.json")"
  LARK_BRAND="$(jq -r '.brand // "feishu"' "$STAGING/credentials/feishu-profile.json")"
  LARK_LANG="$(jq -r '.lang // "zh_cn"' "$STAGING/credentials/feishu-profile.json")"
  EXISTING_PROFILE="$(lark-cli --profile tesla-saving-ticket config show 2>/dev/null || true)"
  if printf '%s' "$EXISTING_PROFILE" \
    | jq -e --arg app_id "$LARK_APP_ID" \
      '(.appId == $app_id) and ((.appSecret | type) == "string") and ((.appSecret | length) > 0)' >/dev/null 2>&1; then
    echo "M1 飞书 profile 已存在且与迁移包匹配，继续导入。"
  else
    printf '%s' "$LARK_APP_SECRET" | lark-cli config init \
      --name tesla-saving-ticket \
      --app-id "$LARK_APP_ID" \
      --app-secret-stdin \
      --brand "$LARK_BRAND" \
      --lang "$LARK_LANG" >/dev/null
  fi
  unset LARK_APP_SECRET EXISTING_PROFILE
  PROFILE_CHECK="$(lark-cli --profile tesla-saving-ticket config show 2>/dev/null || true)"
  if ! printf '%s' "$PROFILE_CHECK" \
    | jq -e --arg app_id "$LARK_APP_ID" \
      '(.appId == $app_id) and ((.appSecret | type) == "string") and ((.appSecret | length) > 0)' >/dev/null 2>&1; then
    echo "M1 飞书 profile 写入后验证失败。" >&2
    exit 1
  fi
  unset PROFILE_CHECK LARK_APP_ID LARK_BRAND LARK_LANG
fi

CURRENT_STAGE="替换 TeslaMate 配置"
cp "$STAGING/infra/teslamate/.env" "$PROJECT_ROOT/infra/teslamate/.env"
chmod 600 "$PROJECT_ROOT/infra/teslamate/.env"
CURRENT_STAGE="停止 M1 旧服务"
stop_worker || true
compose down -v --remove-orphans
CURRENT_STAGE="启动 M1 数据库"
compose up -d database mosquitto
wait_for_database
CURRENT_STAGE="恢复 TeslaMate 数据库"
compose exec -T database pg_restore --clean --if-exists --no-owner --exit-on-error \
  -U teslamate -d teslamate < "$STAGING/teslamate.dump"

CURRENT_STAGE="恢复本地账本与运行状态"
mkdir -p "$PROJECT_ROOT/data/processed" "$PROJECT_ROOT/data/raw"
for name in receipts.json runtime-state.json reference-fuel-prices.json; do
  if [ -f "$STAGING/data/processed/$name" ]; then
    cp "$STAGING/data/processed/$name" "$PROJECT_ROOT/data/processed/$name"
    chmod 600 "$PROJECT_ROOT/data/processed/$name"
  fi
done
if [ -d "$STAGING/data/raw/feishu" ]; then
  rm -rf "$PROJECT_ROOT/data/raw/feishu"
  cp -R "$STAGING/data/raw/feishu" "$PROJECT_ROOT/data/raw/feishu"
  chmod -R go-rwx "$PROJECT_ROOT/data/raw/feishu"
fi
cp "$STAGING/MANIFEST.txt" "$PROJECT_ROOT/data/processed/migration-manifest.txt"
chmod 600 "$PROJECT_ROOT/data/processed/migration-manifest.txt"

CURRENT_STAGE="核对数据库计数"
EXPECTED_DRIVES="$(awk -F= '$1 == "drives" {print $2}' "$STAGING/MANIFEST.txt")"
EXPECTED_POSITIONS="$(awk -F= '$1 == "positions" {print $2}' "$STAGING/MANIFEST.txt")"
EXPECTED_CHARGES="$(awk -F= '$1 == "charging_processes" {print $2}' "$STAGING/MANIFEST.txt")"
ACTUAL="$(database_counts)"
if [ "$ACTUAL" != "$EXPECTED_DRIVES|$EXPECTED_POSITIONS|$EXPECTED_CHARGES" ]; then
  echo "数据库计数不一致：expected=$EXPECTED_DRIVES|$EXPECTED_POSITIONS|$EXPECTED_CHARGES actual=$ACTUAL" >&2
  exit 1
fi

CURRENT_STAGE="启动 M1 正式服务"
if [ "$MODE" = "preflight" ]; then
  compose up -d grafana
  compose stop teslamate >/dev/null 2>&1 || true
  echo "M1 预导入完成：$ACTUAL。TeslaMate 与飞书 Worker 均未启动。"
else
  compose up -d
  "$PROJECT_ROOT/scripts/migration/install-launch-agent.sh"
  echo "M1 最终导入完成：$ACTUAL。TeslaMate 与飞书 Worker 已切换到 M1。"
fi
