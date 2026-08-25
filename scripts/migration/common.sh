#!/bin/bash

set -euo pipefail

MIGRATION_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$MIGRATION_SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/infra/teslamate/compose.yaml"
LAUNCH_LABEL="com.tesla-saving-ticket.worker"
LAUNCH_PLIST="$HOME/Library/LaunchAgents/$LAUNCH_LABEL.plist"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少依赖：$1" >&2
    exit 1
  fi
}

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

worker_is_loaded() {
  launchctl print "gui/$(id -u)/$LAUNCH_LABEL" >/dev/null 2>&1
}

stop_worker() {
  if worker_is_loaded; then
    launchctl bootout "gui/$(id -u)/$LAUNCH_LABEL"
  fi
}

start_installed_worker() {
  if [ -f "$LAUNCH_PLIST" ] && ! worker_is_loaded; then
    launchctl bootstrap "gui/$(id -u)" "$LAUNCH_PLIST"
  fi
}

database_counts() {
  compose exec -T database psql -U teslamate -d teslamate -Atqc \
    "select (select count(*) from drives),(select count(*) from positions),(select count(*) from charging_processes);"
}

wait_for_database() {
  local attempt
  for attempt in $(seq 1 40); do
    if compose exec -T database pg_isready -U teslamate -d teslamate >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "PostgreSQL 在 40 秒内未就绪。" >&2
  return 1
}

read_passphrase() {
  if [ -n "${MIGRATION_PASSPHRASE:-}" ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    echo "需要在交互式终端输入迁移口令。" >&2
    exit 1
  fi
  read -r -s -p "迁移口令：" MIGRATION_PASSPHRASE
  echo
  if [ -z "$MIGRATION_PASSPHRASE" ]; then
    echo "迁移口令不能为空。" >&2
    exit 1
  fi
  export MIGRATION_PASSPHRASE
}
