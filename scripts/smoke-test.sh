#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cd "$TMPDIR"
git init -q

pi -e "$PKG_ROOT" -p "/cook smoke-test mission" >/tmp/pi-completion-smoke.out 2>/tmp/pi-completion-smoke.err &
PI_PID=$!
for _ in $(seq 1 60); do
  if [[ -f .agent/profile.json && -f .agent/state.json && -f .agent/plan.json && -f .agent/active-slice.json ]]; then
    break
  fi
  sleep 1
done
if [[ ! -f .agent/profile.json || ! -f .agent/state.json || ! -f .agent/plan.json || ! -f .agent/active-slice.json ]]; then
  echo "completion bootstrap did not materialize canonical files in time" >&2
  cat /tmp/pi-completion-smoke.err >&2 || true
  kill "$PI_PID" >/dev/null 2>&1 || true
  wait "$PI_PID" >/dev/null 2>&1 || true
  exit 1
fi
kill "$PI_PID" >/dev/null 2>&1 || true
wait "$PI_PID" >/dev/null 2>&1 || true

bash .agent/verify_completion_control_plane.sh >/dev/null
bash .agent/verify_completion_stop.sh >/dev/null

python3 - <<'PY2'
import json
from pathlib import Path
path = Path('.agent/active-slice.json')
active = json.loads(path.read_text())
active.update({
    'status': 'selected',
    'slice_id': 'smoke-slice',
    'goal': 'verify selected handoff schema',
    'contract_ids': ['smoke-contract'],
    'acceptance_criteria': ['criterion'],
    'blocked_on': [],
    'locked_notes': [],
    'must_fix_findings': [],
    'basis_commit': 'deadbeef',
    'remaining_contract_ids_before': ['smoke-contract'],
    'release_blocker_count_before': 1,
    'high_value_gap_count_before': 0,
})
active.pop('priority', None)
active.pop('why_now', None)
path.write_text(json.dumps(active, indent=2) + '\n')
PY2

if bash .agent/verify_completion_control_plane.sh >/dev/null 2>&1; then
  echo "expected control-plane verification to fail when selected active-slice omits priority/why_now" >&2
  exit 1
fi

python3 - <<'PY3'
import json
from pathlib import Path
path = Path('.agent/active-slice.json')
active = json.loads(path.read_text())
active['priority'] = 1
active['why_now'] = 'smoke test exact handoff'
path.write_text(json.dumps(active, indent=2) + '\n')
PY3

bash .agent/verify_completion_control_plane.sh >/dev/null
bash .agent/verify_completion_stop.sh >/dev/null

echo "smoke test passed: $TMPDIR"
