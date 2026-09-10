#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/scripts/errors.sh"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--reset' ) ]]; then
  teamcodex_error INSTALL_ARGUMENT_INVALID
  exit 1
fi
export TEAMCODEX_CONFIG_DIR="${TEAMCODEX_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/teamcodex}"
INSTALL_BIN_DIR="${TEAMCODEX_BIN_DIR:-$HOME/.local/bin}"
umask 077
mkdir -p "$TEAMCODEX_CONFIG_DIR" "$INSTALL_BIN_DIR"

# Preserve an old native installation when switching to Docker.
legacy_config="${TEAMCODEX_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/teamcodex.json}"
if [[ ! -f "$TEAMCODEX_CONFIG_DIR/config.json" && -f "$legacy_config" ]]; then
  cp "$legacy_config" "$TEAMCODEX_CONFIG_DIR/config.json"
  chmod 600 "$TEAMCODEX_CONFIG_DIR/config.json"
  echo "Copied existing config from $legacy_config"
fi
"$ROOT/teamcodex.sh" build
if [[ "${1:-}" == '--reset' ]]; then
  "$ROOT/teamcodex.sh" reset
fi
"$ROOT/teamcodex.sh" init
if [[ -e "$INSTALL_BIN_DIR/teamcodex" && ! -L "$INSTALL_BIN_DIR/teamcodex" ]]; then
  teamcodex_error INSTALL_PATH_EXISTS "$INSTALL_BIN_DIR/teamcodex" "$ROOT/teamcodex.sh"
else
  ln -sfn "$ROOT/teamcodex.sh" "$INSTALL_BIN_DIR/teamcodex"
  echo "Installed Docker launcher: $INSTALL_BIN_DIR/teamcodex"
fi
echo "Config: $TEAMCODEX_CONFIG_DIR/config.json"
echo "Start: $ROOT/teamcodex.sh serve"
echo "Ensure $INSTALL_BIN_DIR is in PATH to use teamcodex from other directories."
