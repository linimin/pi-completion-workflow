#!/usr/bin/env bash
set -euo pipefail

# .agent/verification-evidence.json parity
bash .agent/verify_completion_control_plane.sh >/dev/null
npm run smoke-test >/dev/null
npm run refocus-test >/dev/null
npm run context-proposal-test >/dev/null
bash ./scripts/canonical-evidence-artifact-test.sh >/dev/null
bash ./scripts/active-slice-contract-test.sh >/dev/null
npm run observability-status-test >/dev/null
npm run evaluator-calibration-test >/dev/null
npm run rubric-contract-test >/dev/null
npm run release-check >/dev/null
