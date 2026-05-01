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

mark_done() {
  python3 - <<'PY'
import json
from pathlib import Path

state_path = Path('.agent/state.json')
plan_path = Path('.agent/plan.json')
active_path = Path('.agent/active-slice.json')

state = json.loads(state_path.read_text())
state.update({
    'current_phase': 'done',
    'continuation_policy': 'done',
    'continuation_reason': 'Previous workflow completed.',
    'project_done': True,
    'requires_reground': False,
    'next_mandatory_action': None,
    'next_mandatory_role': None,
    'remaining_stop_judges': 0,
    'last_reground_at': '2026-01-01T00:10:00.000Z',
    'contract_status': 'satisfied',
})
state_path.write_text(json.dumps(state, indent=2) + '\n')

plan = json.loads(plan_path.read_text())
plan.update({
    'plan_basis': 'completed_round_fixture',
    'candidate_slices': [],
})
plan_path.write_text(json.dumps(plan, indent=2) + '\n')

active = json.loads(active_path.read_text())
active.update({
    'status': 'idle',
    'slice_id': None,
    'goal': None,
    'contract_ids': [],
    'acceptance_criteria': [],
    'priority': None,
    'why_now': None,
    'blocked_on': [],
    'locked_notes': [],
    'must_fix_findings': [],
    'basis_commit': None,
    'remaining_contract_ids_before': [],
    'release_blocker_count_before': None,
    'high_value_gap_count_before': None,
})
active_path.write_text(json.dumps(active, indent=2) + '\n')
PY
}

ROOT="$TMPDIR/repo"
mkdir -p "$ROOT"
cd "$ROOT"
git init -q

# No workflow yet: /cook with no goal should infer from recent discussion.
SESSION_ONE="$TMPDIR/session-one.jsonl"
DISCUSSION_ONE=$'Mission: Remove the completion status line while keeping the completion widget.\nScope:\n- Keep the non-running completion widget.\n- Suppress the widget while a completion role is active.\nConstraints:\n- Do not reintroduce any other completion status surface.\nAcceptance:\n- Update README to match the shipped behavior.\n- Keep observability regression coverage truthful.'
write_session "$SESSION_ONE" "$ROOT" "$DISCUSSION_ONE"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ONE" -e "$PKG_ROOT" -p "/cook" >/tmp/pi-completion-context-proposal-bootstrap.out 2>/tmp/pi-completion-context-proposal-bootstrap.err

python3 - <<'PY'
import json
from pathlib import Path

mission = 'Remove the completion status line while keeping the completion widget.'
mission_text = Path('.agent/mission.md').read_text()
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert mission in mission_text, '.agent/mission.md did not record the context-derived mission anchor'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after context-derived bootstrap'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after context-derived bootstrap'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after context-derived bootstrap'
assert state['current_phase'] == 'reground', 'state.json current_phase should start at reground after context-derived bootstrap'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next_mandatory_role should start at completion-regrounder after context-derived bootstrap'
PY

# Completed workflow: /cook with no goal should infer the next round from recent discussion.
mark_done

SESSION_TWO="$TMPDIR/session-two.jsonl"
DISCUSSION_TWO=$'Mission: Ship the next workflow round for richer context-derived /cook startup.\nScope:\n- Start a new workflow round from recent discussion after the previous one is done.\n- Keep using canonical .agent state after confirmation.\nConstraints:\n- Do not resume the completed workflow when the new round is clearly different.\nAcceptance:\n- Reset canonical state back to reground for the new mission.\n- Preserve the tracked completion control-plane files.'
write_session "$SESSION_TWO" "$ROOT" "$DISCUSSION_TWO"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_TWO" -e "$PKG_ROOT" -p "/cook" >/tmp/pi-completion-context-proposal-next-round.out 2>/tmp/pi-completion-context-proposal-next-round.err

python3 - <<'PY'
import json
from pathlib import Path

mission = 'Ship the next workflow round for richer context-derived /cook startup.'
mission_text = Path('.agent/mission.md').read_text()
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert mission in mission_text, '.agent/mission.md did not update to the next-round context-derived mission anchor'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after starting the next workflow round'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after starting the next workflow round'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after starting the next workflow round'
assert state['current_phase'] == 'reground', 'state.json current_phase should reset to reground for the next workflow round'
assert state['continuation_policy'] == 'continue', 'continuation_policy should reset to continue for the next workflow round'
assert state['requires_reground'] is True, 'requires_reground should reset to true for the next workflow round'
assert state['project_done'] is False, 'project_done should reset to false for the next workflow round'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next_mandatory_role should reset to completion-regrounder for the next workflow round'
assert state['continuation_reason'].startswith('User refocused workflow via /cook:'), 'continuation_reason should record the next-round refocus'
assert plan['plan_basis'] == 'user_refocus', 'plan_basis should reset to user_refocus for the next workflow round'
assert active['status'] == 'idle', 'active-slice should reset to idle for the next workflow round'
PY

# Active workflow: /cook <goal> plus refocus should use the explicit goal as the mission anchor,
# while still allowing recent discussion to enrich the proposal before confirmation.
SESSION_THREE="$TMPDIR/session-three.jsonl"
DISCUSSION_THREE=$'Scope:\n- Preserve the richer proposal structure from discussion.\nConstraints:\n- Keep explicit goals as the mission anchor when they conflict with earlier text.\nAcceptance:\n- Refresh canonical state from the replacement mission.'
write_session "$SESSION_THREE" "$ROOT" "$DISCUSSION_THREE"

PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_THREE" -e "$PKG_ROOT" -p "/cook Explicit replacement mission for the active workflow" >/tmp/pi-completion-context-proposal-active-goal.out 2>/tmp/pi-completion-context-proposal-active-goal.err

python3 - <<'PY'
import json
from pathlib import Path

mission = 'Explicit replacement mission for the active workflow.'
mission_text = Path('.agent/mission.md').read_text()
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert mission in mission_text, '.agent/mission.md did not update to the explicit replacement mission anchor'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after explicit-goal replacement'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after explicit-goal replacement'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after explicit-goal replacement'
assert state['current_phase'] == 'reground', 'current_phase should reset to reground after explicit-goal replacement'
assert state['continuation_policy'] == 'continue', 'continuation_policy should stay continue after explicit-goal replacement'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next role should reset to completion-regrounder after explicit-goal replacement'
assert state['continuation_reason'].startswith('User refocused workflow via /cook:'), 'continuation_reason should record the explicit-goal replacement'
assert plan['plan_basis'] == 'user_refocus', 'plan_basis should be user_refocus after explicit-goal replacement'
assert active['status'] == 'idle', 'active slice should reset to idle after explicit-goal replacement'
PY

# Completed workflow again: /cook <goal> should start the next round directly from the explicit goal
# without requiring existing-workflow continue/refocus confirmation.
mark_done

SESSION_FOUR="$TMPDIR/session-four.jsonl"
DISCUSSION_FOUR=$'Mission: This older discussion should not override the explicit next-round goal.\nScope:\n- Reuse discussion details only as supplemental proposal context.\nAcceptance:\n- Start the next round from the explicit goal.'
write_session "$SESSION_FOUR" "$ROOT" "$DISCUSSION_FOUR"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_FOUR" -e "$PKG_ROOT" -p "/cook Explicit goal for the next completed-workflow round" >/tmp/pi-completion-context-proposal-done-goal.out 2>/tmp/pi-completion-context-proposal-done-goal.err

python3 - <<'PY'
import json
from pathlib import Path

mission = 'Explicit goal for the next completed-workflow round.'
mission_text = Path('.agent/mission.md').read_text()
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert mission in mission_text, '.agent/mission.md did not update to the explicit next-round mission anchor'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after explicit-goal next-round start'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after explicit-goal next-round start'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after explicit-goal next-round start'
assert state['current_phase'] == 'reground', 'current_phase should reset to reground after explicit-goal next-round start'
assert state['continuation_policy'] == 'continue', 'continuation_policy should reset to continue after explicit-goal next-round start'
assert state['project_done'] is False, 'project_done should reset to false after explicit-goal next-round start'
assert state['requires_reground'] is True, 'requires_reground should reset to true after explicit-goal next-round start'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next role should reset to completion-regrounder after explicit-goal next-round start'
assert state['continuation_reason'].startswith('User refocused workflow via /cook:'), 'continuation_reason should record the explicit-goal next-round start'
assert plan['plan_basis'] == 'user_refocus', 'plan_basis should be user_refocus after explicit-goal next-round start'
assert active['status'] == 'idle', 'active slice should reset to idle after explicit-goal next-round start'
PY

echo "context proposal test passed: $ROOT"
