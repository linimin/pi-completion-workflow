#!/usr/bin/env bash
set -euo pipefail

bash .agent/verify_completion_control_plane.sh

echo "[completion] checking .agent/verification-evidence.json parity via packaged release gate"
npm run release-check >/dev/null
