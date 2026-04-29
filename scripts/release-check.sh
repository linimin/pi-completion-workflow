#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

npm run smoke-test
npm run refocus-test
npm pack --dry-run >/dev/null

echo "release check passed"
