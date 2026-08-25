#!/bin/bash

set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/common.sh"

MODE="${1:-preflight}"
if [ "$MODE" != "preflight" ] && [ "$MODE" != "cutover" ]; then
  echo "用法：$0 [preflight|cutover]" >&2
  exit 2
fi

require_command node
require_command npm
require_command docker

cd "$PROJECT_ROOT"
npm test

if ! compose ps --status running database | grep -q database; then
  echo "PostgreSQL 未运行。" >&2
  exit 1
fi

COUNTS="$(database_counts)"
if [ -f "$PROJECT_ROOT/data/processed/migration-manifest.txt" ]; then
  EXPECTED_DRIVES="$(awk -F= '$1 == "drives" {print $2}' "$PROJECT_ROOT/data/processed/migration-manifest.txt")"
  EXPECTED_POSITIONS="$(awk -F= '$1 == "positions" {print $2}' "$PROJECT_ROOT/data/processed/migration-manifest.txt")"
  EXPECTED_CHARGES="$(awk -F= '$1 == "charging_processes" {print $2}' "$PROJECT_ROOT/data/processed/migration-manifest.txt")"
  EXPECTED="$EXPECTED_DRIVES|$EXPECTED_POSITIONS|$EXPECTED_CHARGES"
  if [ "$COUNTS" != "$EXPECTED" ]; then
    echo "数据库计数不一致：expected=$EXPECTED actual=$COUNTS" >&2
    exit 1
  fi
fi

npm run test:live

if [ "$MODE" = "preflight" ]; then
  if compose ps --status running teslamate | grep -q teslamate; then
    echo "预验证阶段不应启动 TeslaMate。" >&2
    exit 1
  fi
  if worker_is_loaded; then
    echo "预验证阶段不应启动飞书 Worker。" >&2
    exit 1
  fi
else
  for service in database mosquitto grafana teslamate; do
    if ! compose ps --status running "$service" | grep -q "$service"; then
      echo "服务未运行：$service" >&2
      exit 1
    fi
  done
  if ! worker_is_loaded; then
    echo "飞书 Worker 未运行。" >&2
    exit 1
  fi
fi

echo "M1 $MODE 验证通过：drives|positions|charging_processes=$COUNTS"
