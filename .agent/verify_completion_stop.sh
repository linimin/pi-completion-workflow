#!/usr/bin/env bash
set -euo pipefail

bash .agent/verify_completion_control_plane.sh

echo "[completion] rerunning evaluator calibration gate"
npm run evaluator-calibration-test >/dev/null

echo "[completion] checking .agent/verification-evidence.json parity via packaged release gate"
npm run release-check >/dev/null
