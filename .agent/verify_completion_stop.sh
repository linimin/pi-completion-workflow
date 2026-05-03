#!/usr/bin/env bash
set -euo pipefail

bash .agent/verify_completion_control_plane.sh
npm run evaluator-calibration-test >/dev/null
npm run release-check >/dev/null
echo "[completion] baseline verifier ran control-plane checks (including .agent/verification-evidence.json parity), evaluator calibration, and npm run release-check (including canonical evidence artifacts and active-slice contract coverage)"
