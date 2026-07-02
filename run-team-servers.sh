#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

TEAMCODEX_DIR="${TEAMCODEX_DIR:-$ROOT/teamcodex}"
TEAMCLAUDE_DIR="${TEAMCLAUDE_DIR:-$ROOT/teamclaude}"
TEAMCODEX_SESSION="${TEAMCODEX_SESSION:-teamcodex-server}"
TEAMCLAUDE_SESSION="${TEAMCLAUDE_SESSION:-teamclaude-server}"

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command not found: $command_name" >&2
    exit 1
  fi
}

require_checkout() {
  local name="$1"
  local dir="$2"

  if [[ ! -f "$dir/package.json" ]]; then
    echo "error: $name checkout not found at $dir" >&2
    echo "Run ./install-team-repos.sh first." >&2
    exit 1
  fi
}

start_session() {
  local session="$1"
  local dir="$2"
  local command="$3"

  if tmux has-session -t "=$session" 2>/dev/null; then
    echo "tmux session already running: $session"
    return
  fi

  tmux new-session -d -s "$session" -c "$dir" "exec $command"
  sleep 0.2

  if tmux has-session -t "=$session" 2>/dev/null; then
    echo "started $session: $command"
  else
    echo "warning: $session exited immediately: $command" >&2
  fi
}

require_command tmux
require_command npm

require_checkout teamcodex "$TEAMCODEX_DIR"
require_checkout teamclaude "$TEAMCLAUDE_DIR"

start_session "$TEAMCODEX_SESSION" "$TEAMCODEX_DIR" "npm start -- serve"
start_session "$TEAMCLAUDE_SESSION" "$TEAMCLAUDE_DIR" "npm start -- server"

echo
echo "Attach to a server:"
echo "  tmux attach -t $TEAMCODEX_SESSION"
echo "  tmux attach -t $TEAMCLAUDE_SESSION"
