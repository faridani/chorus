#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" = "0" ]]; then
  run_uid="${CHORUS_RUN_UID:-1000}"
  run_gid="${CHORUS_RUN_GID:-1000}"

  groupmod -o -g "$run_gid" chorus >/dev/null 2>&1 || true
  usermod -o -u "$run_uid" -g "$run_gid" -d /home/chorus chorus >/dev/null 2>&1 || true

  mkdir -p /var/lib/chorus /home/chorus/.npm-global/bin
  chown -R "$run_uid:$run_gid" /var/lib/chorus /home/chorus >/dev/null 2>&1 || true

  exec gosu chorus "$@"
fi

exec "$@"
