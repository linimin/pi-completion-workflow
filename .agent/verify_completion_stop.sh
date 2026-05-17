#!/usr/bin/env bash
set -euo pipefail

echo "[completion] verifying .agent/verification-evidence.json parity and packaged release baseline"
bash .agent/verify_completion_control_plane.sh >/dev/null
npm run evaluator-calibration-test >/dev/null
if [[ "${PI_COMPLETION_STOP_VERIFY_IN_RELEASE_CHECK:-0}" != "1" ]]; then
  PI_COMPLETION_STOP_VERIFY_IN_RELEASE_CHECK=1 npm run release-check >/dev/null
fi
echo "[completion] repo-level stop verification passed"
