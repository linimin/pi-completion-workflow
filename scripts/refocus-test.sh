#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cd "$TMPDIR"
git init -q

pi -e "$PKG_ROOT" -p "/cook smoke-test mission" >/tmp/pi-completion-refocus-bootstrap.out 2>/tmp/pi-completion-refocus-bootstrap.err &
PI_PID=$!
for _ in $(seq 1 60); do
  if [[ -f .agent/profile.json && -f .agent/state.json && -f .agent/plan.json && -f .agent/active-slice.json ]]; then
    break
  fi
  sleep 1
done
if [[ ! -f .agent/profile.json || ! -f .agent/state.json || ! -f .agent/plan.json || ! -f .agent/active-slice.json ]]; then
  echo "completion bootstrap did not materialize canonical files in time" >&2
  cat /tmp/pi-completion-refocus-bootstrap.err >&2 || true
  kill "$PI_PID" >/dev/null 2>&1 || true
  wait "$PI_PID" >/dev/null 2>&1 || true
  exit 1
fi
kill "$PI_PID" >/dev/null 2>&1 || true
wait "$PI_PID" >/dev/null 2>&1 || true

INITIAL_MISSION="$(python3 - <<'PY'
import json
from pathlib import Path
state = json.loads(Path('.agent/state.json').read_text())
print(state['mission_anchor'])
PY
)"

PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi -e "$PKG_ROOT" -p "/cook refocused smoke-test mission with tests and docs" \
  >/tmp/pi-completion-refocus.out 2>/tmp/pi-completion-refocus.err

python3 - <<'PY'
import json
from pathlib import Path

new_anchor = 'refocused smoke-test mission with tests and docs parity.'
mission_text = Path('.agent/mission.md').read_text()
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert new_anchor in mission_text, '.agent/mission.md did not update to the refocused mission anchor'
assert state['mission_anchor'] == new_anchor, 'state.json mission_anchor mismatch after refocus'
assert plan['mission_anchor'] == new_anchor, 'plan.json mission_anchor mismatch after refocus'
assert active['mission_anchor'] == new_anchor, 'active-slice.json mission_anchor mismatch after refocus'
assert state['current_phase'] == 'reground', 'state.json current_phase should reset to reground after refocus'
assert state['requires_reground'] is True, 'state.json requires_reground should be true after refocus'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next_mandatory_role should reset to completion-regrounder'
assert state['continuation_reason'].startswith('User refocused workflow via /cook:'), 'continuation_reason should record the refocus'
assert plan['plan_basis'] == 'user_refocus', 'plan.json plan_basis should be user_refocus after refocus'
assert active['status'] == 'idle', 'active-slice.json status should reset to idle after refocus'
PY

UPDATED_MISSION="$(python3 - <<'PY'
import json
from pathlib import Path
state = json.loads(Path('.agent/state.json').read_text())
print(state['mission_anchor'])
PY
)"

if [[ "$INITIAL_MISSION" == "$UPDATED_MISSION" ]]; then
  echo "expected mission anchor to change during refocus" >&2
  exit 1
fi

echo "refocus test passed: $TMPDIR"
