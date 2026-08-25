#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
env_file="$script_dir/../infra/teslamate/.env"

if [ -e "$env_file" ]; then
  echo "TeslaMate .env already exists; leaving it unchanged."
  exit 0
fi

umask 077
encryption_key=$(openssl rand -hex 32)
database_password=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c 1-40)
grafana_password=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c 1-40)

{
  printf 'TM_ENCRYPTION_KEY=%s\n' "$encryption_key"
  printf 'TM_DB_PASSWORD=%s\n' "$database_password"
  printf 'TM_GRAFANA_ADMIN_PASSWORD=%s\n' "$grafana_password"
} > "$env_file"

chmod 600 "$env_file"
echo "Created local TeslaMate secrets at infra/teslamate/.env (mode 600)."
