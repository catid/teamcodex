#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

REPOS=(
  "teamcodex|https://github.com/catid/teamcodex.git"
  "teamclaude|https://github.com/catid/teamclaude.git"
)

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "error: required command not found: $command_name" >&2
    exit 1
  fi
}

canonical_origin() {
  local url="${1%.git}"

  url="${url#https://github.com/}"
  url="${url#http://github.com/}"
  url="${url#git@github.com:}"

  echo "$url"
}

same_origin() {
  local actual
  local expected

  actual="$(canonical_origin "$1")"
  expected="$(canonical_origin "$2")"

  [[ "$actual" == "$expected" ]]
}

clone_or_update() {
  local name="$1"
  local url="$2"
  local target="$ROOT/$name"

  if [[ -d "$target/.git" ]]; then
    local origin
    origin="$(git -C "$target" remote get-url origin 2>/dev/null || true)"

    if [[ -n "$origin" ]] && ! same_origin "$origin" "$url"; then
      echo "error: $target already exists with a different origin: $origin" >&2
      exit 1
    fi

    echo "Updating $name..."
    git -C "$target" fetch --prune
    git -C "$target" pull --ff-only
  elif [[ -e "$target" ]]; then
    echo "error: $target already exists but is not a git checkout" >&2
    exit 1
  else
    echo "Cloning $name..."
    git clone "$url" "$target"
  fi
}

install_repo() {
  local name="$1"
  local target="$ROOT/$name"

  echo "Installing $name..."
  npm install --prefix "$target"
}

require_command git
require_command npm

for repo in "${REPOS[@]}"; do
  IFS="|" read -r name url <<<"$repo"
  clone_or_update "$name" "$url"
  install_repo "$name"
done

echo
echo "Installed repositories under $ROOT:"
echo "  $ROOT/teamcodex"
echo "  $ROOT/teamclaude"
