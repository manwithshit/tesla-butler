#!/bin/bash

set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
  CHECK_ONLY=1
elif [ "$#" -gt 0 ]; then
  echo "用法：$0 [--check]" >&2
  exit 2
fi

require_command node
require_command docker
require_command lark-cli
require_command plutil

NODE_CLI="$(command -v node)"
DOCKER_CLI="$(command -v docker)"
LARK_CLI="$(command -v lark-cli)"
TEMPLATE="$PROJECT_ROOT/infra/launchd/$LAUNCH_LABEL.plist"
TARGET="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"
PROFILE="${LARK_PROFILE:-tesla-saving-ticket}"

escape_sed() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

ROOT_ESCAPED="$(escape_sed "$PROJECT_ROOT")"
NODE_ESCAPED="$(escape_sed "$NODE_CLI")"
DOCKER_ESCAPED="$(escape_sed "$DOCKER_CLI")"
LARK_ESCAPED="$(escape_sed "$LARK_CLI")"

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_ROOT/data/processed/logs"
TEMP_PLIST="$(mktemp "${TMPDIR:-/tmp}/$LAUNCH_LABEL.XXXXXX")"
trap 'rm -f "$TEMP_PLIST"' EXIT

sed \
  -e "s|__PROJECT_ROOT__|$ROOT_ESCAPED|g" \
  -e "s|__NODE_CLI__|$NODE_ESCAPED|g" \
  -e "s|__DOCKER_CLI__|$DOCKER_ESCAPED|g" \
  -e "s|__LARK_CLI__|$LARK_ESCAPED|g" \
  "$TEMPLATE" > "$TEMP_PLIST"
plutil -lint "$TEMP_PLIST" >/dev/null

if [ "$CHECK_ONLY" -eq 1 ]; then
  if grep -Eq "__[A-Z_]+__" "$TEMP_PLIST"; then
    echo "LaunchAgent 模板仍有未替换变量。" >&2
    exit 1
  fi
  echo "LaunchAgent 模板渲染验证通过。"
  exit 0
fi

if ! "$LARK_CLI" --profile "$PROFILE" config show >/dev/null 2>&1; then
  echo "M1 尚未配置飞书 profile：$PROFILE。请先安全完成 lark-cli config init。" >&2
  exit 1
fi

stop_worker || true
cp "$TEMP_PLIST" "$TARGET"
chmod 600 "$TARGET"
launchctl bootstrap "gui/$(id -u)" "$TARGET"
launchctl kickstart -k "gui/$(id -u)/$LAUNCH_LABEL"
echo "飞书 Worker LaunchAgent 已安装并启动：$TARGET"
