#!/usr/bin/env bash
set -euo pipefail

bash .agent/verify_completion_control_plane.sh
npm run release-check >/dev/null
echo "[completion] baseline verifier ran control-plane checks plus npm run release-check"
