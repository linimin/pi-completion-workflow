#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bash .agent/verify_completion_control_plane.sh
npm run evaluator-calibration-test >/dev/null
npm run release-check >/dev/null
echo "[completion] baseline verifier ran control-plane checks (including .agent/verification-evidence.json parity), evaluator calibration, and the direct package verification entrypoints via npm run release-check (including canonical evidence artifacts, active-slice contract coverage, and repo-local bare /cook checks that self-isolate inside the tracked scripts)"
