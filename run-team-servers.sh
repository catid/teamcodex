#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
echo 'Starting TeamCodex with Docker Compose. TeamClaude is managed separately.'
exec "$ROOT/teamcodex.sh" serve "$@"
