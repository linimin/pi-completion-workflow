#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cd "$TMPDIR"
git init -q

pi -e "$PKG_ROOT" -p "/completion-init smoke-test mission" >/dev/null 2>&1

[[ -f .agent/profile.json ]]
[[ -f .agent/state.json ]]
[[ -f .agent/plan.json ]]
[[ -f .agent/active-slice.json ]]

bash .agent/verify_completion_control_plane.sh >/dev/null
bash .agent/verify_completion_stop.sh >/dev/null

echo "smoke test passed: $TMPDIR"
