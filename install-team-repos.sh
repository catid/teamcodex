#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
echo 'Installing this TeamCodex checkout with Docker. TeamClaude is managed separately.'
exec "$ROOT/install.sh" "$@"
