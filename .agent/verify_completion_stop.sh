#!/usr/bin/env bash
set -euo pipefail

bash .agent/verify_completion_control_plane.sh
echo "[completion] no repo-specific verifier auto-detected; control-plane verification only"
