#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-check] running startup/refocus/context regressions, including critique-aware /cook confirmation coverage"
npm run smoke-test
npm run refocus-test
npm run context-proposal-test
npm run observability-status-test
npm run rubric-contract-test
npm pack --dry-run >/dev/null

echo "release check passed"
