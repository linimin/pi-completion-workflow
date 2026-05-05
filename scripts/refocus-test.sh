#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

write_session() {
  local session_path="$1"
  local cwd="$2"
  local text="$3"
  python3 - "$session_path" "$cwd" "$text" <<'PY'
import json
import sys
from pathlib import Path

session_path = Path(sys.argv[1])
cwd = sys.argv[2]
text = sys.argv[3]
session_path.parent.mkdir(parents=True, exist_ok=True)
entries = [
    {
        "type": "session",
        "version": 3,
        "id": "11111111-1111-4111-8111-111111111111",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "cwd": cwd,
    },
    {
        "type": "message",
        "id": "a1b2c3d4",
        "parentId": None,
        "timestamp": "2026-01-01T00:00:01.000Z",
        "message": {
            "role": "user",
            "content": text,
            "timestamp": 1767225601000,
        },
    },
]
with session_path.open('w', encoding='utf-8') as fh:
    for entry in entries:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
PY
}

cd "$TMPDIR"
git init -q

pi -e "$PKG_ROOT" -p "/cook smoke-test mission" >"$TMPDIR/pi-completion-refocus-bootstrap.out" 2>"$TMPDIR/pi-completion-refocus-bootstrap.err" &
PI_PID=$!
for _ in $(seq 1 60); do
  if [[ -f .agent/profile.json && -f .agent/state.json && -f .agent/plan.json && -f .agent/active-slice.json ]]; then
    break
  fi
  sleep 1
done
if [[ ! -f .agent/profile.json || ! -f .agent/state.json || ! -f .agent/plan.json || ! -f .agent/active-slice.json ]]; then
  echo "completion bootstrap did not materialize canonical files in time" >&2
  cat "$TMPDIR/pi-completion-refocus-bootstrap.err" >&2 || true
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
  >"$TMPDIR/pi-completion-refocus-cancel.out" 2>"$TMPDIR/pi-completion-refocus-cancel.err"

python3 - "$CHOOSER_SNAPSHOT" "$TMPDIR/pi-completion-refocus-cancel.out" "$TMPDIR/pi-completion-refocus-cancel.err" "$INITIAL_MISSION" <<'PY'
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
assert chooser['choices'][1].startswith('Abandon current workflow and start this new one'), 'chooser should keep the explicit-goal refocus option'
assert 'Start/Cancel confirmation' in chooser['choices'][1], 'chooser should mention the approval-only replacement confirmation'
assert chooser['choices'][2].startswith('Cancel'), 'chooser should keep the cancel option'
assert 'Discuss changes in the main chat and rerun /cook.' in chooser['choices'][2], 'chooser cancel copy should redirect users back to the main chat and rerun /cook'
assert 'Discuss changes in the main chat and rerun /cook.' in output, 'chooser cancel output should redirect users back to the main chat and rerun /cook'
PY

EXPLICIT_ROUTING_SNAPSHOT="$TMPDIR/explicit-goal-routing.json"
PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH="$EXPLICIT_ROUTING_SNAPSHOT" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi -e "$PKG_ROOT" -p "/cook Remove completion status line, keep widget" \
  >"$TMPDIR/pi-completion-refocus.out" 2>"$TMPDIR/pi-completion-refocus.err"

python3 - "$EXPLICIT_ROUTING_SNAPSHOT" <<'PY'
import json
import sys
from pathlib import Path

new_anchor = 'Remove completion status line, keep widget.'
expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
routing = json.loads(Path(sys.argv[1]).read_text())
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
assert routing['mode'] == 'explicit', 'explicit /cook <goal> should use explicit active-workflow routing mode'
assert routing['action'] == 'refocus', 'explicit /cook <goal> should classify as refocus when the mission changes'
assert routing['reason'] == 'explicit_goal', 'explicit /cook <goal> should record the explicit-goal routing reason'
assert routing['proposedMissionAnchor'] == new_anchor, 'explicit routing snapshot should expose the replacement mission anchor'
PY

UPDATED_MISSION="$(python3 - <<'PY'
import json
from pathlib import Path
state = json.loads(Path('.agent/state.json').read_text())
print(state['mission_anchor'])
PY
)"

if [[ "$INITIAL_MISSION" == "$UPDATED_MISSION" ]]; then
  echo "expected mission anchor to change during explicit refocus" >&2
  exit 1
fi

# Negated replacement missions that contain the current anchor must still reach the conservative chooser and final Start/Cancel gate.
BARE_REFOCUS_MISSION='Do not remove completion status line, keep widget.'
BARE_REFOCUS_DISCUSSION=$'Mission: Do not remove completion status line, keep widget.\nScope:\n- Treat the active bare /cook discussion as a replacement workflow rather than a resume.\n- Keep the replacement behind the existing approval-only Start/Cancel gate.\nConstraints:\n- Do not rewrite canonical state before the final Start confirmation.\nAcceptance:\n- Add deterministic coverage proving the chooser and final approval path for this negated replacement mission.'

SESSION_BARE_CHOOSER_CANCEL="$TMPDIR/session-bare-chooser-cancel.jsonl"
BARE_CHOOSER_SNAPSHOT="$TMPDIR/bare-existing-workflow-chooser.json"
BARE_ROUTING_CHOOSER_CANCEL="$TMPDIR/bare-routing-chooser-cancel.json"
write_session "$SESSION_BARE_CHOOSER_CANCEL" "$TMPDIR" "$BARE_REFOCUS_DISCUSSION"

PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_EXISTING_WORKFLOW_ACTION=cancel \
PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH="$BARE_CHOOSER_SNAPSHOT" \
PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH="$BARE_ROUTING_CHOOSER_CANCEL" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_BARE_CHOOSER_CANCEL" -e "$PKG_ROOT" -p "/cook" \
  >"$TMPDIR/pi-completion-bare-chooser-cancel.out" 2>"$TMPDIR/pi-completion-bare-chooser-cancel.err"

python3 - "$BARE_CHOOSER_SNAPSHOT" "$BARE_ROUTING_CHOOSER_CANCEL" "$TMPDIR/pi-completion-bare-chooser-cancel.out" "$TMPDIR/pi-completion-bare-chooser-cancel.err" "$UPDATED_MISSION" "$BARE_REFOCUS_MISSION" <<'PY'
import json
import sys
from pathlib import Path

chooser = json.loads(Path(sys.argv[1]).read_text())
routing = json.loads(Path(sys.argv[2]).read_text())
output = Path(sys.argv[3]).read_text() + Path(sys.argv[4]).read_text()
updated_mission = sys.argv[5]
replacement_mission = sys.argv[6]
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert state['mission_anchor'] == updated_mission, 'chooser cancel should keep the current mission anchor'
assert plan['mission_anchor'] == updated_mission, 'chooser cancel should keep plan.json unchanged'
assert active['mission_anchor'] == updated_mission, 'chooser cancel should keep active-slice.json unchanged'
assert routing['mode'] == 'bare', 'bare /cook should snapshot bare active-workflow routing mode'
assert routing['action'] == 'refocus', 'clear structured discussion should classify active bare /cook as refocus'
assert routing['reason'] == 'clear_refocus', 'clear structured discussion should record the clear-refocus routing reason'
assert routing['currentMissionAnchor'] == updated_mission, 'clear-refocus routing should keep the current mission anchor until the user approves replacement'
assert routing['proposedMissionAnchor'] == replacement_mission, 'clear-refocus routing should expose the proposed replacement mission'
assert chooser['title'].startswith('Existing completion workflow found'), 'bare chooser snapshot should describe the existing-workflow prompt'
assert chooser['choices'][0].startswith('Continue current workflow'), 'bare chooser should keep the continue option'
assert chooser['choices'][1].startswith('Start new workflow from recent discussion'), 'bare chooser should offer the recent-discussion refocus option'
assert 'Start/Cancel confirmation' in chooser['choices'][1], 'bare chooser should mention the approval-only replacement confirmation'
assert chooser['choices'][2].startswith('Cancel'), 'bare chooser should keep the cancel option'
assert 'Discuss changes in the main chat and rerun /cook.' in output, 'bare chooser cancel should redirect users back to the main chat and rerun /cook'
PY

SESSION_BARE_FINAL_CANCEL="$TMPDIR/session-bare-final-cancel.jsonl"
BARE_ROUTING_FINAL_CANCEL="$TMPDIR/bare-routing-final-cancel.json"
BARE_PROPOSAL_CANCEL="$TMPDIR/bare-replacement-proposal-cancel.json"
write_session "$SESSION_BARE_FINAL_CANCEL" "$TMPDIR" "$BARE_REFOCUS_DISCUSSION"

PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=cancel \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$BARE_PROPOSAL_CANCEL" \
PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH="$BARE_ROUTING_FINAL_CANCEL" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_BARE_FINAL_CANCEL" -e "$PKG_ROOT" -p "/cook" \
  >"$TMPDIR/pi-completion-bare-final-cancel.out" 2>"$TMPDIR/pi-completion-bare-final-cancel.err"

python3 - "$BARE_PROPOSAL_CANCEL" "$BARE_ROUTING_FINAL_CANCEL" "$TMPDIR/pi-completion-bare-final-cancel.out" "$TMPDIR/pi-completion-bare-final-cancel.err" "$UPDATED_MISSION" "$BARE_REFOCUS_MISSION" <<'PY'
import json
import sys
from pathlib import Path

proposal = json.loads(Path(sys.argv[1]).read_text())
routing = json.loads(Path(sys.argv[2]).read_text())
output = Path(sys.argv[3]).read_text() + Path(sys.argv[4]).read_text()
updated_mission = sys.argv[5]
replacement_mission = sys.argv[6]
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert state['mission_anchor'] == updated_mission, 'final Start/Cancel cancel should keep the current mission anchor'
assert plan['mission_anchor'] == updated_mission, 'final Start/Cancel cancel should keep plan.json unchanged'
assert active['mission_anchor'] == updated_mission, 'final Start/Cancel cancel should keep active-slice.json unchanged'
assert routing['action'] == 'refocus', 'final Start/Cancel cancel should still come from a clear-refocus classification'
assert routing['reason'] == 'clear_refocus', 'final Start/Cancel cancel should preserve the clear-refocus reason'
assert routing['currentMissionAnchor'] == updated_mission, 'final Start/Cancel cancel should keep the current mission anchor until the user approves replacement'
assert proposal['mission'] == replacement_mission, 'final Start/Cancel cancel should still prepare the replacement proposal before rewriting state'
assert 'Discuss changes in the main chat and rerun /cook.' in output, 'final Start/Cancel cancel should redirect users back to the main chat and rerun /cook'
PY

SESSION_BARE_ACCEPT="$TMPDIR/session-bare-accept.jsonl"
BARE_ROUTING_ACCEPT="$TMPDIR/bare-routing-accept.json"
BARE_PROPOSAL_ACCEPT="$TMPDIR/bare-replacement-proposal-accept.json"
write_session "$SESSION_BARE_ACCEPT" "$TMPDIR" "$BARE_REFOCUS_DISCUSSION"

PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$BARE_PROPOSAL_ACCEPT" \
PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH="$BARE_ROUTING_ACCEPT" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_BARE_ACCEPT" -e "$PKG_ROOT" -p "/cook" \
  >"$TMPDIR/pi-completion-bare-accept.out" 2>"$TMPDIR/pi-completion-bare-accept.err"

python3 - "$BARE_PROPOSAL_ACCEPT" "$BARE_ROUTING_ACCEPT" <<'PY'
import json
import sys
from pathlib import Path

new_anchor = 'Do not remove completion status line, keep widget.'
expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
proposal = json.loads(Path(sys.argv[1]).read_text())
routing = json.loads(Path(sys.argv[2]).read_text())
mission_text = Path('.agent/mission.md').read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert proposal['mission'] == new_anchor, 'accepted bare refocus should preserve the replacement proposal mission'
assert routing['mode'] == 'bare', 'accepted bare refocus should keep bare routing mode'
assert routing['action'] == 'refocus', 'accepted bare refocus should keep the clear-refocus classification'
assert routing['reason'] == 'clear_refocus', 'accepted bare refocus should keep the clear-refocus reason'
assert routing['currentMissionAnchor'] == 'Remove completion status line, keep widget.', 'accepted bare refocus should expose the original mission until Start is accepted'
assert new_anchor in mission_text, '.agent/mission.md did not update to the bare refocus mission anchor'
assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after bare refocus'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after bare refocus'
assert state['mission_anchor'] == new_anchor, 'state.json mission_anchor mismatch after bare refocus'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after bare refocus'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after bare refocus'
assert plan['mission_anchor'] == new_anchor, 'plan.json mission_anchor mismatch after bare refocus'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after bare refocus'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after bare refocus'
assert active['mission_anchor'] == new_anchor, 'active-slice.json mission_anchor mismatch after bare refocus'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after bare refocus'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after bare refocus'
assert state['current_phase'] == 'reground', 'state.json current_phase should reset to reground after bare refocus'
assert state['requires_reground'] is True, 'state.json requires_reground should be true after bare refocus'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next_mandatory_role should reset to completion-regrounder after bare refocus'
assert state['continuation_reason'].startswith('User refocused workflow via /cook:'), 'continuation_reason should record the bare refocus'
assert plan['plan_basis'] == 'user_refocus', 'plan.json plan_basis should be user_refocus after bare refocus'
assert active['status'] == 'idle', 'active-slice.json status should reset to idle after bare refocus'
PY

echo "refocus test passed: $TMPDIR"
