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

CHOOSER_SNAPSHOT="$TMPDIR/existing-workflow-chooser.json"
PI_COMPLETION_EXISTING_WORKFLOW_ACTION=cancel \
PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH="$CHOOSER_SNAPSHOT" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi -e "$PKG_ROOT" -p "/cook replacement mission that should stay in the main chat" \
  >/tmp/pi-completion-refocus-cancel.out 2>/tmp/pi-completion-refocus-cancel.err

python3 - "$CHOOSER_SNAPSHOT" "/tmp/pi-completion-refocus-cancel.out" "/tmp/pi-completion-refocus-cancel.err" "$INITIAL_MISSION" <<'PY'
import json
import sys
from pathlib import Path

chooser = json.loads(Path(sys.argv[1]).read_text())
output = Path(sys.argv[2]).read_text() + Path(sys.argv[3]).read_text()
initial_mission = sys.argv[4]
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert state['mission_anchor'] == initial_mission, 'cancelled chooser should keep the current mission anchor'
assert plan['mission_anchor'] == initial_mission, 'cancelled chooser should keep plan.json unchanged'
assert active['mission_anchor'] == initial_mission, 'cancelled chooser should keep active-slice.json unchanged'
assert chooser['title'].startswith('Existing completion workflow found'), 'chooser snapshot should describe the existing-workflow prompt'
assert chooser['choices'][0].startswith('Continue current workflow'), 'chooser should keep the continue option'
assert chooser['choices'][1].startswith('Abandon current workflow and start this new one'), 'chooser should keep the refocus option'
assert 'Start/Cancel confirmation' in chooser['choices'][1], 'chooser should mention the approval-only replacement confirmation'
assert chooser['choices'][2].startswith('Cancel'), 'chooser should keep the cancel option'
assert 'Discuss changes in the main chat and rerun /cook.' in chooser['choices'][2], 'chooser cancel copy should redirect users back to the main chat and rerun /cook'
assert 'Discuss changes in the main chat and rerun /cook.' in output, 'chooser cancel output should redirect users back to the main chat and rerun /cook'
PY

PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi -e "$PKG_ROOT" -p "/cook refocused smoke-test mission with tests and docs" \
  >/tmp/pi-completion-refocus.out 2>/tmp/pi-completion-refocus.err

python3 - <<'PY'
import json
from pathlib import Path

new_anchor = 'refocused smoke-test mission with tests and docs parity.'
expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
mission_text = Path('.agent/mission.md').read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert new_anchor in mission_text, '.agent/mission.md did not update to the refocused mission anchor'
assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after refocus'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after refocus'
assert state['mission_anchor'] == new_anchor, 'state.json mission_anchor mismatch after refocus'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after refocus'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after refocus'
assert plan['mission_anchor'] == new_anchor, 'plan.json mission_anchor mismatch after refocus'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after refocus'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after refocus'
assert active['mission_anchor'] == new_anchor, 'active-slice.json mission_anchor mismatch after refocus'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after refocus'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after refocus'
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
