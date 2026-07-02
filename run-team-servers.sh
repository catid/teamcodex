#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

TEAMCODEX_DIR="${TEAMCODEX_DIR:-$ROOT/teamcodex}"
TEAMCLAUDE_DIR="${TEAMCLAUDE_DIR:-$ROOT/teamclaude}"
TEAMCODEX_SESSION="${TEAMCODEX_SESSION:-teamcodex-server}"
TEAMCLAUDE_SESSION="${TEAMCLAUDE_SESSION:-teamclaude-server}"
STARTUP_GRACE_SECONDS="${STARTUP_GRACE_SECONDS:-1}"

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
  local status_file="${TMPDIR:-/tmp}/run-team-servers-$session.status"
  local pane_command

  if tmux has-session -t "=$session" 2>/dev/null; then
    echo "stopping existing tmux session: $session"
    tmux kill-session -t "=$session"
  fi

  rm -f "$status_file"
  printf -v pane_command '%s; status=$?; printf "\\n%s exited with status %%s\\n" "$status"; printf "%%s\\n" "$status" > %q; exec "${SHELL:-bash}" -i' \
    "$command" "$session" "$status_file"

  tmux new-session -d -s "$session" -c "$dir" "$pane_command"
  sleep "$STARTUP_GRACE_SECONDS"

  if [[ -f "$status_file" ]]; then
    echo "warning: $session exited immediately with status $(<"$status_file"): $command"
    echo
    echo "Recent output from $session:"
    tmux capture-pane -pt "$session:0.0" -S -80 | sed '/^[[:space:]]*$/d' || true
    echo
    return 1
  elif tmux has-session -t "=$session" 2>/dev/null; then
    echo "started $session: $command"
  else
    echo "warning: $session exited immediately: $command"
    return 1
  fi
}

require_command tmux
require_command npm

require_checkout teamcodex "$TEAMCODEX_DIR"
require_checkout teamclaude "$TEAMCLAUDE_DIR"

failed=0
start_session "$TEAMCODEX_SESSION" "$TEAMCODEX_DIR" "npm start -- serve" || failed=1
start_session "$TEAMCLAUDE_SESSION" "$TEAMCLAUDE_DIR" "npm start -- server" || failed=1

echo
echo "Attach to a server:"
echo "  tmux attach -t $TEAMCODEX_SESSION"
echo "  tmux attach -t $TEAMCLAUDE_SESSION"

exit "$failed"
