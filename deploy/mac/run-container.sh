#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-start}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

IMAGE="${CHORUS_IMAGE:-chorus:local}"
NAME="${CHORUS_CONTAINER_NAME:-chorus}"
PORT="${CHORUS_PORT:-7878}"
CPUS="${CHORUS_CPUS:-4}"
MEMORY="${CHORUS_MEMORY:-8g}"
INSTALL_AI_CLIS="${CHORUS_INSTALL_AI_CLIS:-true}"
DATA_DIR="${CHORUS_DATA_DIR_HOST:-$HOME/.chorus-container/data}"
HOME_DIR="${CHORUS_HOME_DIR_HOST:-$HOME/.chorus-container/home}"
CONFIG_FILE="${CHORUS_CONFIG_FILE:-$REPO_ROOT/chorus.config.json}"

require_container() {
  if ! command -v container >/dev/null 2>&1; then
    cat >&2 <<'EOF'
Apple container CLI is required.
Install it from https://github.com/apple/container/releases, then run:
  container system start
EOF
    exit 1
  fi
}

prepare_dirs() {
  mkdir -p "$DATA_DIR" "$HOME_DIR"
  DATA_DIR="$(cd -- "$DATA_DIR" && pwd -P)"
  HOME_DIR="$(cd -- "$HOME_DIR" && pwd -P)"

  mkdir -p \
    "$HOME_DIR/.config" \
    "$HOME_DIR/.codex" \
    "$HOME_DIR/.claude" \
    "$HOME_DIR/.gemini" \
    "$HOME_DIR/.ssh"
}

inherited_env_args() {
  local key
  for key in \
    OPENAI_API_KEY \
    ANTHROPIC_API_KEY \
    GEMINI_API_KEY \
    GOOGLE_API_KEY \
    GITHUB_TOKEN \
    GH_TOKEN \
    CHORUS_ALLOW_REMOTE_TERMINAL; do
    if [[ -n "${!key:-}" ]]; then
      printf '%s\n' "--env" "$key"
    fi
  done
}

start_container() {
  require_container
  prepare_dirs
  if [[ -f "$CONFIG_FILE" ]]; then
    CONFIG_FILE="$(cd -- "$(dirname -- "$CONFIG_FILE")" && pwd -P)/$(basename -- "$CONFIG_FILE")"
  fi

  container system start
  container build \
    --build-arg "INSTALL_AI_CLIS=$INSTALL_AI_CLIS" \
    --tag "$IMAGE" \
    --file "$REPO_ROOT/deploy/Containerfile" \
    "$REPO_ROOT"

  container stop "$NAME" >/dev/null 2>&1 || true
  container delete --force "$NAME" >/dev/null 2>&1 || true

  local run_args=(
    run
    --detach
    --name "$NAME"
    --init
    --cpus "$CPUS"
    --memory "$MEMORY"
    --publish "127.0.0.1:$PORT:7878"
    --env "CHORUS_HOST=0.0.0.0"
    --env "CHORUS_PORT=7878"
    --env "CHORUS_DATA_DIR=/var/lib/chorus"
    --env "HOME=/home/chorus"
    --env "CHORUS_RUN_UID=$(id -u)"
    --env "CHORUS_RUN_GID=$(id -g)"
    --volume "$DATA_DIR:/var/lib/chorus"
    --volume "$HOME_DIR:/home/chorus"
  )

  if [[ -f "$CONFIG_FILE" ]]; then
    run_args+=(--volume "$CONFIG_FILE:/app/chorus.config.json")
  fi

  if [[ -n "${SSH_AUTH_SOCK:-}" ]]; then
    run_args+=(--ssh)
  fi

  while IFS= read -r arg; do
    run_args+=("$arg")
  done < <(inherited_env_args)

  container "${run_args[@]}" "$IMAGE"
  echo "Chorus is starting at http://127.0.0.1:$PORT"
  echo "Run '$0 logs' to follow logs or '$0 shell' to authenticate gh/codex/claude/gemini."
}

case "$ACTION" in
  start|restart)
    start_container
    ;;
  shell)
    require_container
    container exec --interactive --tty "$NAME" /bin/bash
    ;;
  logs)
    require_container
    container logs --follow "$NAME"
    ;;
  stop)
    require_container
    container stop "$NAME"
    ;;
  rm|remove)
    require_container
    container delete --force "$NAME"
    ;;
  status)
    require_container
    container list --all
    ;;
  *)
    echo "Usage: $0 [start|restart|shell|logs|stop|rm|status]" >&2
    exit 2
    ;;
esac
