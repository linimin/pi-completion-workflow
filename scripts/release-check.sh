#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-check] running control-plane validation, startup/refocus/context regressions, canonical evidence artifact, active-slice contract, observability, evaluator calibration, and rubric contract coverage"
bash .agent/verify_completion_control_plane.sh
npm run smoke-test
npm run refocus-test
npm run context-proposal-test
bash ./scripts/canonical-evidence-artifact-test.sh
bash ./scripts/active-slice-contract-test.sh
npm run observability-status-test
npm run evaluator-calibration-test
npm run rubric-contract-test
npm pack --dry-run >/dev/null

echo "release check passed"
