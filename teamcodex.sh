#!/usr/bin/env bash
set -euo pipefail

# Compatible with macOS's Bash 3.2 and Ubuntu's Bash 5.
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR="$(cd -P -- "$(dirname -- "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" = /* ]] || SOURCE="$SOURCE_DIR/$SOURCE"
done
ROOT="$(cd -P -- "$(dirname -- "$SOURCE")" && pwd)"
export TEAMCODEX_CONFIG_DIR="${TEAMCODEX_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/teamcodex}"
export TEAMCODEX_CODEX_HOME="${TEAMCODEX_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
TEAMCODEX_UID="$(id -u)"
# sg/newgrp changes the process's primary group. Keep the container's group
# stable so switching between a fresh shell and old tmux does not recreate it.
TEAMCODEX_GID="$(id -g "$(id -un)")"
export TEAMCODEX_UID TEAMCODEX_GID
export TEAMCODEX_PORT="${TEAMCODEX_PORT:-1456}"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo 'Docker with the Compose plugin is required. See README.md for macOS and Ubuntu setup.' >&2
  exit 1
fi
if ! docker_error="$(docker info 2>&1 >/dev/null)"; then
  # Existing tmux servers keep the groups from when they started. Activate an
  # already granted Docker membership for this invocation without sudo or logout.
  if [[ "$(uname -s)" == Linux && "${TEAMCODEX_DOCKER_GROUP_RETRY:-0}" != 1 ]] &&
      command -v sg >/dev/null 2>&1 &&
      [[ " $(id -nG "$(id -un)") " == *' docker '* && " $(id -nG) " != *' docker '* ]]; then
    echo 'Activating your existing Docker group membership for this command (older shell/tmux session).' >&2
    export TEAMCODEX_DOCKER_GROUP_RETRY=1
    group_command=exec
    # sg executes through /bin/sh: use POSIX single quoting, including literal
    # quotes/newlines in prompts. Bash printf %q is not portable to that shell.
    for arg in "$ROOT/teamcodex.sh" "$@"; do
      quoted_arg=${arg//\'/\'\\\'\'}
      group_command+=" '$quoted_arg'"
    done
    exec sg docker -c "$group_command"
  fi
  echo 'Cannot access Docker. On macOS, start Docker Desktop or Colima; on Linux, check the Docker service and socket permissions.' >&2
  if [[ -n "$docker_error" ]]; then printf '%s\n' "$docker_error" >&2; fi
  exit 1
fi
unset TEAMCODEX_DOCKER_GROUP_RETRY
umask 077
mkdir -p "$TEAMCODEX_CONFIG_DIR" "$TEAMCODEX_CODEX_HOME"
TEAMCODEX_CONFIG_DIR="$(cd -- "$TEAMCODEX_CONFIG_DIR" && pwd)"
TEAMCODEX_CODEX_HOME="$(cd -- "$TEAMCODEX_CODEX_HOME" && pwd)"
COMPOSE=(docker compose --project-directory "$ROOT" -f "$ROOT/compose.yaml")

cli() {
  local tty_args=(-T)
  local stdin_args=(--interactive=false)
  if [[ -t 0 && -t 1 ]]; then tty_args=(); fi
  if [[ "${1:-}" == 'login' ]]; then stdin_args=(--interactive=true); fi
  "${COMPOSE[@]}" run --rm --no-deps "${stdin_args[@]}" ${tty_args[@]+"${tty_args[@]}"} \
    -e TEAMCODEX_SERVER_URL=http://teamcodex:1456 teamcodex "$@"
}

command_name="${1:-serve}"
if [[ $# -gt 0 ]]; then shift; fi
case "$command_name" in
  build) "${COMPOSE[@]}" build "$@" ;;
  serve|server|start) "${COMPOSE[@]}" up -d --wait "$@" ;;
  stop) "${COMPOSE[@]}" down "$@" ;;
  restart) "${COMPOSE[@]}" up -d --force-recreate --wait "$@" ;;
  logs) "${COMPOSE[@]}" logs --tail=100 -f "$@" ;;
  ps) "${COMPOSE[@]}" ps "$@" ;;
  reset)
    "${COMPOSE[@]}" stop teamcodex
    cli reset "$@"
    ;;
  run|resume|fork)
    if [[ "$command_name" != run ]]; then set -- "$command_name" "$@"; fi
    if ! command -v codex >/dev/null 2>&1; then
      echo 'Install Codex CLI on the host before using teamcodex run.' >&2
      exit 1
    fi
    "${COMPOSE[@]}" up -d --wait >&2
    launch_file="$(mktemp "${TMPDIR:-/tmp}/teamcodex-launch.XXXXXX")"
    trap 'rm -f "$launch_file"' EXIT
    "${COMPOSE[@]}" run --rm --no-deps --interactive=false -T teamcodex env --null > "$launch_file"
    launch_args=()
    while IFS= read -r -d '' value; do launch_args+=("$value"); done < "$launch_file"
    rm -f "$launch_file"
    if [[ ${#launch_args[@]} -lt 3 ]]; then echo 'Failed to read Codex launch settings.' >&2; exit 1; fi
    export TEAMCODEX_API_KEY="${launch_args[0]}"
    codex_args=()
    bypass=1
    if [[ "${1:-}" == '--' ]]; then shift; fi
    config_args=()
    while [[ $# -gt 0 ]]; do
      arg="$1"; shift
      case "$arg" in
        --safe) bypass=0 ;;
        -c|--config)
          if [[ $# -eq 0 ]]; then echo "$arg requires a value" >&2; exit 1; fi
          config_args+=("$arg" "$1"); shift ;;
        --config=*|-c=*) config_args+=("$arg") ;;
        --) codex_args+=(-- "$@"); break ;;
        *) codex_args+=("$arg") ;;
      esac
    done
    config_args+=("${launch_args[@]:1}")
    if [[ "$bypass" == 1 ]]; then config_args+=(--dangerously-bypass-approvals-and-sandbox); fi
    # Put every -c override in the subcommand scope and before a literal --.
    final_args=()
    inserted=0
    for arg in ${codex_args[@]+"${codex_args[@]}"}; do
      if [[ "$arg" == '--' && "$inserted" == 0 ]]; then
        final_args+=("${config_args[@]}"); inserted=1
      fi
      final_args+=("$arg")
    done
    if [[ "$inserted" == 0 ]]; then final_args+=("${config_args[@]}"); fi
    exec codex "${final_args[@]}"
    ;;
  login)
    for arg in "$@"; do
      if [[ "$arg" == '--browser' ]]; then
        echo 'Docker login uses device authorization. Run teamcodex login --device-auth.' >&2
        exit 1
      fi
    done
    cli login "$@"
    ;;
  help|--help|-h)
    echo 'Docker: teamcodex build | serve | stop | restart | logs | ps'
    echo 'Host Codex: teamcodex run [--safe] [Codex arguments]'
    echo 'Sessions: teamcodex resume [Codex arguments] | fork [Codex arguments]'
    echo 'Reset: teamcodex reset (stops server; keeps accounts and creates a backup)'
    cli help
    ;;
  *) cli "$command_name" "$@" ;;
esac
