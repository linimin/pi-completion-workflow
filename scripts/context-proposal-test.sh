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

# No workflow yet: bare /cook should use strict structured discussion fallback when analyst output is unavailable.
SESSION_ZERO="$TMPDIR/session-zero.jsonl"
DISCUSSION_ZERO=$'Mission: Remove the completion status line while keeping the completion widget.\nScope:\n- Keep the non-running completion widget.\n- Suppress the widget while a completion role is active.\nConstraints:\n- Do not reintroduce any other completion status surface.\nAcceptance:\n- Update README to match the shipped behavior.\n- Keep observability regression coverage truthful.'
DISCUSSION_SNAPSHOT_ZERO="$TMPDIR/context-proposal-structured-fallback.json"
write_session "$SESSION_ZERO" "$ROOT" "$DISCUSSION_ZERO"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-structured-fallback.out" 2>"$TMPDIR/pi-completion-context-proposal-structured-fallback.err"

python3 - "$DISCUSSION_SNAPSHOT_ZERO" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Remove the completion status line while keeping the completion widget.'
expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
mission_text = Path('.agent/mission.md').read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())
proposal = json.loads(Path(sys.argv[1]).read_text())

assert Path('.agent').exists(), 'strict structured fallback should only create canonical state after Start is accepted'
assert mission in mission_text, '.agent/mission.md did not record the structured-fallback mission anchor'
assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after structured-fallback bootstrap'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after structured-fallback bootstrap'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after structured-fallback bootstrap'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after structured-fallback bootstrap'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after structured-fallback bootstrap'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after structured-fallback bootstrap'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after structured-fallback bootstrap'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after structured-fallback bootstrap'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after structured-fallback bootstrap'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after structured-fallback bootstrap'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after structured-fallback bootstrap'
assert proposal['mission'] == mission, 'structured-fallback proposal snapshot should preserve the discussion mission anchor'
assert proposal['source'] == 'session', 'structured-fallback proposal snapshot should record the strict session fallback source'
assert proposal['scope'] == ['Keep the non-running completion widget.', 'Suppress the widget while a completion role is active.'], 'structured-fallback proposal snapshot should preserve discussion scope'
assert proposal['constraints'] == ['Do not reintroduce any other completion status surface.'], 'structured-fallback proposal snapshot should preserve discussion constraints'
assert proposal['acceptance'] == ['Update README to match the shipped behavior.', 'Keep observability regression coverage truthful.'], 'structured-fallback proposal snapshot should preserve discussion acceptance'
assert state['current_phase'] == 'reground', 'state.json current_phase should start at reground after structured-fallback bootstrap'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next_mandatory_role should start at completion-regrounder after structured-fallback bootstrap'
assert state['continuation_reason'].startswith('User started workflow via /cook:'), 'structured-fallback startup should record the accepted startup routing in continuation_reason'
assert 'task_type=completion-workflow' in state['continuation_reason'], 'structured-fallback startup should persist the selected task_type in continuation_reason'
assert 'evaluation_profile=completion-rubric-v1' in state['continuation_reason'], 'structured-fallback startup should persist the selected evaluation_profile in continuation_reason'
PY

rm -rf .agent

# No workflow yet: bare /cook should fail closed on ambiguous structured discussion when analyst output is unavailable.
SESSION_ZERO_AMBIG="$TMPDIR/session-zero-ambiguous.jsonl"
DISCUSSION_ZERO_AMBIG=$'Mission: Remove the completion status line while keeping the completion widget.\nScope:\n- Keep the non-running completion widget.\nConstraints:\n- Do not reintroduce any other completion status surface.\nAcceptance:\n- Update README to match the shipped behavior.\nMission: Ship an unrelated widget overhaul.\nScope:\n- Replace the widget entirely.'
write_session "$SESSION_ZERO_AMBIG" "$ROOT" "$DISCUSSION_ZERO_AMBIG"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_AMBIG" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-ambiguous.out" 2>"$TMPDIR/pi-completion-context-proposal-ambiguous.err"

python3 - "$TMPDIR/pi-completion-context-proposal-ambiguous.out" "$TMPDIR/pi-completion-context-proposal-ambiguous.err" <<'PY'
import sys
from pathlib import Path

output = Path(sys.argv[1]).read_text() + Path(sys.argv[2]).read_text()
assert not Path('.agent').exists(), 'ambiguous structured discussion should fail closed without writing canonical state'
assert 'Bare /cook failed closed' in output, 'ambiguous structured discussion should explain the fail-closed startup outcome'
assert 'Mission/Scope/Constraints/Acceptance' in output, 'ambiguous structured discussion should explain the strict fallback requirement'
PY

# No workflow yet: /cook with no goal should infer from recent discussion through analyst output.
SESSION_ONE="$TMPDIR/session-one.jsonl"
DISCUSSION_ONE="$DISCUSSION_ZERO"
ANALYST_OUTPUT_ONE='{"mission":"Remove the completion status line while keeping the completion widget.","scope":["Keep the non-running completion widget.","Suppress the widget while a completion role is active."],"constraints":["Do not reintroduce any other completion status surface."],"acceptance":["Update README to match the shipped behavior.","Keep observability regression coverage truthful."],"critique":["Keep critique separate from the mission anchor so startup analysis does not rewrite the workflow goal."],"risks":["Stale widget-removal discussion could broaden the startup plan if it gets treated as mission text."],"task_type":"completion-workflow","evaluation_profile":"completion-rubric-v1","possible_noise":["older widget restyle ideas"],"confidence":0.94}'
DISCUSSION_SNAPSHOT_ONE="$TMPDIR/context-proposal-discussion-hints.json"
write_session "$SESSION_ONE" "$ROOT" "$DISCUSSION_ONE"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT="$ANALYST_OUTPUT_ONE" \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ONE" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ONE" -e "$PKG_ROOT" -p "/cook" >/tmp/pi-completion-context-proposal-bootstrap.out 2>/tmp/pi-completion-context-proposal-bootstrap.err

python3 - "$DISCUSSION_SNAPSHOT_ONE" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Remove the completion status line while keeping the completion widget.'
expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
mission_text = Path('.agent/mission.md').read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())
proposal = json.loads(Path(sys.argv[1]).read_text())

assert mission in mission_text, '.agent/mission.md did not record the analyst-derived mission anchor'
assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after analyst-derived bootstrap'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after analyst-derived bootstrap'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after analyst-derived bootstrap'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after analyst-derived bootstrap'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after analyst-derived bootstrap'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after analyst-derived bootstrap'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after analyst-derived bootstrap'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after analyst-derived bootstrap'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after analyst-derived bootstrap'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after analyst-derived bootstrap'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after analyst-derived bootstrap'
assert proposal['mission'] == mission, 'discussion-only proposal snapshot should keep the inferred mission anchor'
assert proposal['analysis']['taskType'] == expected_task_type, 'discussion-only proposal snapshot should expose task_type hints separately'
assert proposal['analysis']['evaluationProfile'] == expected_eval_profile, 'discussion-only proposal snapshot should expose evaluation_profile hints separately'
assert proposal['analysis']['critique'] == ['Keep critique separate from the mission anchor so startup analysis does not rewrite the workflow goal.'], 'discussion-only proposal snapshot should preserve critique hints'
assert proposal['analysis']['risks'] == ['Stale widget-removal discussion could broaden the startup plan if it gets treated as mission text.'], 'discussion-only proposal snapshot should preserve risk hints'
assert proposal['analysis']['possibleNoise'] == ['older widget restyle ideas'], 'discussion-only proposal snapshot should preserve possible_noise hints'
assert 'Critique:' not in proposal['goalText'], 'goalText should keep critique separate from mission/scope/constraints/acceptance'
assert 'Task type:' not in proposal['goalText'], 'goalText should keep task_type hints separate from the mission body'
assert state['current_phase'] == 'reground', 'state.json current_phase should start at reground after analyst-derived bootstrap'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next_mandatory_role should start at completion-regrounder after analyst-derived bootstrap'
assert state['continuation_reason'].startswith('User started workflow via /cook:'), 'initial startup should record the accepted startup routing in continuation_reason'
assert 'task_type=completion-workflow' in state['continuation_reason'], 'initial startup should persist the selected task_type in continuation_reason'
assert 'evaluation_profile=completion-rubric-v1' in state['continuation_reason'], 'initial startup should persist the selected evaluation_profile in continuation_reason'
assert 'Keep critique separate from the mission anchor so startup analysis does not rewrite the workflow goal.' in state['continuation_reason'], 'initial startup should persist the accepted critique outcome in continuation_reason'
PY

# Completed workflow: bare /cook should use the same strict structured fallback for the next workflow round when analyst output is unavailable.
mark_done

SESSION_TWO="$TMPDIR/session-two.jsonl"
DISCUSSION_TWO=$'Mission: Ship the next workflow round for richer context-derived /cook startup.\nScope:\n- Start a new workflow round from recent discussion after the previous one is done.\n- Keep using canonical .agent state after confirmation.\nConstraints:\n- Do not resume the completed workflow when the new round is clearly different.\nAcceptance:\n- Reset canonical state back to reground for the new mission.\n- Preserve the tracked completion control-plane files.'
DISCUSSION_SNAPSHOT_TWO="$TMPDIR/context-proposal-next-round-structured-fallback.json"
write_session "$SESSION_TWO" "$ROOT" "$DISCUSSION_TWO"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_TWO" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_TWO" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-next-round.out" 2>"$TMPDIR/pi-completion-context-proposal-next-round.err"

python3 - "$DISCUSSION_SNAPSHOT_TWO" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Ship the next workflow round for richer context-derived /cook startup.'
expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
mission_text = Path('.agent/mission.md').read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())
proposal = json.loads(Path(sys.argv[1]).read_text())

assert mission in mission_text, '.agent/mission.md did not update to the next-round context-derived mission anchor'
assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after next-round startup'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after next-round startup'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after starting the next workflow round'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after starting the next workflow round'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after starting the next workflow round'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after starting the next workflow round'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after starting the next workflow round'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after starting the next workflow round'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after starting the next workflow round'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after starting the next workflow round'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after starting the next workflow round'
assert proposal['mission'] == mission, 'next-round structured-fallback proposal snapshot should preserve the discussion mission anchor'
assert proposal['source'] == 'session', 'next-round structured-fallback proposal snapshot should record the strict session fallback source'
assert state['current_phase'] == 'reground', 'state.json current_phase should reset to reground for the next workflow round'
assert state['continuation_policy'] == 'continue', 'continuation_policy should reset to continue for the next workflow round'
assert state['requires_reground'] is True, 'requires_reground should reset to true for the next workflow round'
assert state['project_done'] is False, 'project_done should reset to false for the next workflow round'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next_mandatory_role should reset to completion-regrounder for the next workflow round'
assert state['continuation_reason'].startswith('User refocused workflow via /cook:'), 'continuation_reason should record the next-round refocus'
assert 'task_type=completion-workflow' in state['continuation_reason'], 'next-round refocus should persist the selected task_type'
assert 'evaluation_profile=completion-rubric-v1' in state['continuation_reason'], 'next-round refocus should persist the selected evaluation_profile'
assert 'critique outcome=accepted critique=none' in state['continuation_reason'], 'next-round refocus should persist that no critique notes were accepted'
assert plan['plan_basis'] == 'user_refocus', 'plan_basis should reset to user_refocus for the next workflow round'
assert active['status'] == 'idle', 'active-slice should reset to idle for the next workflow round'
PY

# Active workflow: /cook <goal> plus refocus should keep the explicit goal as the mission anchor
# even when analyst output is unavailable and structured session fallback is present.
SESSION_THREE="$TMPDIR/session-three.jsonl"
DISCUSSION_THREE=$'Scope:\n- Preserve the richer proposal structure from discussion.\nConstraints:\n- Keep explicit goals as the mission anchor when they conflict with earlier text.\nAcceptance:\n- Refresh canonical state from the replacement mission.'
write_session "$SESSION_THREE" "$ROOT" "$DISCUSSION_THREE"

PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_THREE" -e "$PKG_ROOT" -p "/cook Explicit replacement mission for the active workflow" >/tmp/pi-completion-context-proposal-active-goal.out 2>/tmp/pi-completion-context-proposal-active-goal.err

python3 - <<'PY'
import json
from pathlib import Path

mission = 'Explicit replacement mission for the active workflow.'
expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
mission_text = Path('.agent/mission.md').read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert mission in mission_text, '.agent/mission.md did not update to the explicit replacement mission anchor'
assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after explicit-goal replacement'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after explicit-goal replacement'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after explicit-goal replacement'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after explicit-goal replacement'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after explicit-goal replacement'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after explicit-goal replacement'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after explicit-goal replacement'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after explicit-goal replacement'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after explicit-goal replacement'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after explicit-goal replacement'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after explicit-goal replacement'
assert state['current_phase'] == 'reground', 'current_phase should reset to reground after explicit-goal replacement'
assert state['continuation_policy'] == 'continue', 'continuation_policy should stay continue after explicit-goal replacement'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next role should reset to completion-regrounder after explicit-goal replacement'
assert state['continuation_reason'].startswith('User refocused workflow via /cook:'), 'continuation_reason should record the explicit-goal replacement'
assert 'task_type=completion-workflow' in state['continuation_reason'], 'explicit-goal replacement should persist the selected task_type'
assert 'evaluation_profile=completion-rubric-v1' in state['continuation_reason'], 'explicit-goal replacement should persist the selected evaluation_profile'
assert 'critique outcome=accepted critique=none' in state['continuation_reason'], 'explicit-goal replacement should persist the accepted critique outcome even when no critique was derived'
assert 'Preserve the richer proposal structure from discussion.' not in state['continuation_reason'], 'session scope should not be merged when analyst output is unavailable'
assert 'Keep explicit goals as the mission anchor when they conflict with earlier text.' not in state['continuation_reason'], 'session constraints should not be merged when analyst output is unavailable'
assert 'Refresh canonical state from the replacement mission.' not in state['continuation_reason'], 'session acceptance should not be merged when analyst output is unavailable'
assert plan['plan_basis'] == 'user_refocus', 'plan_basis should be user_refocus after explicit-goal replacement'
assert active['status'] == 'idle', 'active slice should reset to idle after explicit-goal replacement'
PY

# Active workflow: cancelling the replacement proposal should keep the current workflow and redirect
# the user back to the main chat before rerunning /cook.
SESSION_THREE_CANCEL="$TMPDIR/session-three-cancel.jsonl"
DISCUSSION_THREE_CANCEL=$'Scope:\n- Keep the current workflow unchanged when replacement confirmation is cancelled.\nConstraints:\n- Do not rewrite canonical state after cancel.\nAcceptance:\n- Print rerun guidance.'
write_session "$SESSION_THREE_CANCEL" "$ROOT" "$DISCUSSION_THREE_CANCEL"

PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=cancel \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_THREE_CANCEL" -e "$PKG_ROOT" -p "/cook Cancelled replacement mission for the active workflow" >"$TMPDIR/pi-completion-context-proposal-replacement-cancel.out" 2>"$TMPDIR/pi-completion-context-proposal-replacement-cancel.err"

python3 - "$TMPDIR/pi-completion-context-proposal-replacement-cancel.out" "$TMPDIR/pi-completion-context-proposal-replacement-cancel.err" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Explicit replacement mission for the active workflow.'
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())
output = Path(sys.argv[1]).read_text() + Path(sys.argv[2]).read_text()

assert state['mission_anchor'] == mission, 'replacement proposal cancel should keep the existing mission anchor'
assert plan['mission_anchor'] == mission, 'replacement proposal cancel should keep plan.json unchanged'
assert active['mission_anchor'] == mission, 'replacement proposal cancel should keep active-slice.json unchanged'
assert 'Discuss changes in the main chat and rerun /cook.' in output, 'replacement proposal cancel should redirect back to the main chat and rerun /cook'
PY

# Completed workflow again: /cook <goal> should start the next round directly from the explicit goal
# even when analyst output is unavailable, without merging session-derived scope, constraints, or acceptance.
mark_done

SESSION_FOUR="$TMPDIR/session-four.jsonl"
DISCUSSION_FOUR=$'Scope:\n- Add session-only scope.\n- Restyle widget.\nConstraints:\n- Keep rules.\nAcceptance:\n- Add test.'
EXPLICIT_GOAL_FOUR=$'Mission: Filter scope by mission.\nScope:\n- Keep explicit scope.\nCritique:\n- Keep critique notes separate from the mission anchor.\nRisks:\n- Session-only scope could leak into the next workflow round.\nTask type: completion-workflow\nEvaluation profile: completion-rubric-v1'
EXPLICIT_SNAPSHOT_FOUR="$TMPDIR/context-proposal-explicit-hints.json"
write_session "$SESSION_FOUR" "$ROOT" "$DISCUSSION_FOUR"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$EXPLICIT_SNAPSHOT_FOUR" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_FOUR" -e "$PKG_ROOT" -p "/cook $EXPLICIT_GOAL_FOUR" >/tmp/pi-completion-context-proposal-done-goal.out 2>/tmp/pi-completion-context-proposal-done-goal.err

python3 - "$EXPLICIT_SNAPSHOT_FOUR" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Filter scope by mission.'
expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
mission_text = Path('.agent/mission.md').read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())
proposal = json.loads(Path(sys.argv[1]).read_text())
continuation_reason = state['continuation_reason']

assert mission in mission_text, '.agent/mission.md did not update to the explicit next-round mission anchor'
assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after explicit-goal next-round start'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after explicit-goal next-round start'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after explicit-goal next-round start'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after explicit-goal next-round start'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after explicit-goal next-round start'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after explicit-goal next-round start'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after explicit-goal next-round start'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after explicit-goal next-round start'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after explicit-goal next-round start'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after explicit-goal next-round start'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after explicit-goal next-round start'
assert proposal['mission'] == mission, 'explicit-goal proposal snapshot should preserve the explicit mission anchor'
assert proposal['analysis']['taskType'] == expected_task_type, 'explicit-goal proposal snapshot should preserve task_type hints from the goal text'
assert proposal['analysis']['evaluationProfile'] == expected_eval_profile, 'explicit-goal proposal snapshot should preserve evaluation_profile hints from the goal text'
assert proposal['analysis']['critique'] == ['Keep critique notes separate from the mission anchor.'], 'explicit-goal proposal snapshot should preserve critique hints from the goal text'
assert proposal['analysis']['risks'] == ['Session-only scope could leak into the next workflow round.'], 'explicit-goal proposal snapshot should preserve risk hints from the goal text'
assert 'Critique:' not in proposal['goalText'], 'goalText should keep critique notes separate from mission/scope/constraints/acceptance'
assert 'Task type:' not in proposal['goalText'], 'goalText should keep task_type hints separate from the mission body'
assert state['current_phase'] == 'reground', 'current_phase should reset to reground after explicit-goal next-round start'
assert state['continuation_policy'] == 'continue', 'continuation_policy should reset to continue after explicit-goal next-round start'
assert state['project_done'] is False, 'project_done should reset to false after explicit-goal next-round start'
assert state['requires_reground'] is True, 'requires_reground should reset to true after explicit-goal next-round start'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next role should reset to completion-regrounder after explicit-goal next-round start'
assert continuation_reason.startswith('User refocused workflow via /cook:'), 'continuation_reason should record the explicit-goal next-round start'
assert 'task_type=completion-workflow' in continuation_reason, 'explicit-goal next-round start should persist the selected task_type'
assert 'evaluation_profile=completion-rubric-v1' in continuation_reason, 'explicit-goal next-round start should persist the selected evaluation_profile'
assert 'Keep critique notes separate from the mission anchor.' in continuation_reason, 'explicit-goal next-round start should persist the accepted critique outcome'
assert 'Keep explicit scope.' in continuation_reason, 'explicit scope should remain in the explicit-goal proposal'
assert 'Add session-only scope.' not in continuation_reason, 'session-derived scope should not be merged when analyst output is unavailable'
assert 'Restyle widget.' not in continuation_reason, 'unrelated session-derived scope should not be merged when analyst output is unavailable'
assert 'Keep rules.' not in continuation_reason, 'session-derived constraints should not merge when analyst output is unavailable'
assert 'Add test.' not in continuation_reason, 'session-derived acceptance should not merge when analyst output is unavailable'
assert plan['plan_basis'] == 'user_refocus', 'plan_basis should be user_refocus after explicit-goal next-round start'
assert active['status'] == 'idle', 'active slice should reset to idle after explicit-goal next-round start'
PY

# Completed workflow again: /cook with no goal should be able to use model-assisted
# analysis of natural discussion when discussion-only startup depends on analyst output.
mark_done

SESSION_FIVE="$TMPDIR/session-five.jsonl"
DISCUSSION_FIVE=$'I do not want to rewrite the parser. The safer path is to let /cook analyze the discussion first, keep the user\'s explicit mission if they provided one, and ignore stale scope that drifted in from earlier turns. We should still prove it with a regression test before writing canonical state.'
ANALYST_OUTPUT_FIVE='{"mission":"Use a proposal analyst to summarize natural discussion before /cook writes canonical state.","scope":["Keep explicit goals anchored.","Drop stale scope from earlier turns."],"constraints":["Do not rewrite the parser."],"acceptance":["Add a regression test."],"confidence":0.91,"possible_noise":["old unrelated scope"]}'
write_session "$SESSION_FIVE" "$ROOT" "$DISCUSSION_FIVE"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT="$ANALYST_OUTPUT_FIVE" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_FIVE" -e "$PKG_ROOT" -p "/cook" >/tmp/pi-completion-context-proposal-analyst.out 2>/tmp/pi-completion-context-proposal-analyst.err

python3 - <<'PY'
import json
from pathlib import Path

mission = 'Use a proposal analyst to summarize natural discussion before /cook writes canonical state.'
expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
mission_text = Path('.agent/mission.md').read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())
continuation_reason = state['continuation_reason']

assert mission in mission_text, '.agent/mission.md did not record the analyst-derived mission anchor'
assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after analyst-derived restart'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after analyst-derived restart'
assert state['mission_anchor'] == mission, 'state.json mission_anchor mismatch after analyst-derived bootstrap'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after analyst-derived bootstrap'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after analyst-derived bootstrap'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor mismatch after analyst-derived bootstrap'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after analyst-derived bootstrap'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after analyst-derived bootstrap'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor mismatch after analyst-derived bootstrap'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after analyst-derived bootstrap'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after analyst-derived bootstrap'
assert state['current_phase'] == 'reground', 'current_phase should reset to reground after analyst-derived bootstrap'
assert state['next_mandatory_role'] == 'completion-regrounder', 'next role should reset to completion-regrounder after analyst-derived bootstrap'
assert continuation_reason.startswith('User refocused workflow via /cook:'), 'continuation_reason should record the analyst-derived restart'
assert 'task_type=completion-workflow' in continuation_reason, 'analyst-derived restart should persist the selected task_type'
assert 'evaluation_profile=completion-rubric-v1' in continuation_reason, 'analyst-derived restart should persist the selected evaluation_profile'
assert 'critique outcome=accepted critique=none' in continuation_reason, 'analyst-derived restart should persist that no critique notes were accepted'
assert 'Keep explicit goals anchored.' in continuation_reason, 'analyst-derived scope should be preserved'
PY

# Custom confirmation UI: start should render proposal content separately from approval-only Start/Cancel actions.
UI_ROOT_START="$TMPDIR/ui-root-start"
mkdir -p "$UI_ROOT_START"
cd "$UI_ROOT_START"
git init -q

UI_SESSION_START="$TMPDIR/ui-session-start.jsonl"
UI_DISCUSSION_START=$'Mission: Replace the crowded selector with a clearer action layout.\nScope:\n- Separate proposal text from actions.\nConstraints:\n- Preserve approval-only Start/Cancel behavior.\nAcceptance:\n- Add regression coverage.'
UI_ANALYST_OUTPUT_START='{"mission":"Replace the crowded selector with a clearer action layout.","scope":["Separate proposal text from actions."],"constraints":["Preserve approval-only Start/Cancel behavior."],"acceptance":["Add regression coverage."],"critique":["Keep critique details separate from the approval-only proposal summary."],"risks":["Bundling critique into the action list would make the confirmation harder to scan."],"task_type":"completion-workflow","evaluation_profile":"completion-rubric-v1","possible_noise":["old selector wording"],"confidence":0.95}'
UI_SNAPSHOT_START="$TMPDIR/context-proposal-ui-start.json"
write_session "$UI_SESSION_START" "$UI_ROOT_START" "$UI_DISCUSSION_START"

PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_ACTION=start \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_PATH="$UI_SNAPSHOT_START" \
PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT="$UI_ANALYST_OUTPUT_START" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$UI_SESSION_START" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-ui-start.out" 2>"$TMPDIR/pi-completion-context-proposal-ui-start.err"

python3 - "$UI_SNAPSHOT_START" <<'PY'
import json
import sys
from pathlib import Path

snapshot = json.loads(Path(sys.argv[1]).read_text())
state = json.loads(Path('.agent/state.json').read_text())

assert snapshot['proposalHeading'] == 'Proposed workflow', 'custom confirmation snapshot should expose a dedicated proposal section'
assert snapshot['critiqueHeading'] == 'Critique and risks', 'custom confirmation snapshot should expose critique separately from the proposal body'
assert snapshot['routingHeading'] == 'Routing recommendations', 'custom confirmation snapshot should expose routing recommendations separately from the proposal body'
assert 'approval-only' in snapshot['intro'], 'custom confirmation intro should explain the approval-only gate'
assert state['task_type'] == 'completion-workflow', 'start action should preserve canonical task_type'
assert state['evaluation_profile'] == 'completion-rubric-v1', 'start action should preserve canonical evaluation_profile'
assert 'Mission\nReplace the crowded selector with a clearer action layout.' in snapshot['proposalBody'], 'proposal body should be captured separately from the action list'
assert 'Keep critique details separate from the approval-only proposal summary.' not in snapshot['proposalBody'], 'critique notes should not be embedded in the proposal body'
assert 'Critique\n- Keep critique details separate from the approval-only proposal summary.' in snapshot['critiqueBody'], 'critique section should render accepted critique notes separately'
assert 'Risks\n- Bundling critique into the action list would make the confirmation harder to scan.' in snapshot['critiqueBody'], 'critique section should render risk notes separately'
assert 'Possible noise\n- old selector wording' in snapshot['critiqueBody'], 'critique section should render possible-noise notes separately'
assert '- task_type: completion-workflow' in snapshot['routingBody'], 'routing section should render the recommended task_type'
assert '- evaluation_profile: completion-rubric-v1' in snapshot['routingBody'], 'routing section should render the recommended evaluation_profile'
assert [action['id'] for action in snapshot['actions']] == ['start', 'cancel'], 'custom confirmation actions should stay Start/Cancel only'
assert [action['label'] for action in snapshot['actions']] == ['Start', 'Cancel'], 'custom confirmation action labels should be concise'
assert 'Discuss changes in the main chat and rerun /cook.' in snapshot['actions'][1]['description'], 'cancel action should redirect users back to the main chat and rerun /cook'
for action in snapshot['actions']:
    assert 'Replace the crowded selector with a clearer action layout.' not in action['label'], 'proposal mission should not be embedded in action labels'
    assert 'Separate proposal text from actions.' not in action['description'], 'proposal scope should not be embedded in action descriptions'
assert state['mission_anchor'] == 'Replace the crowded selector with a clearer action layout.', 'start action should still accept the proposed mission'
assert state['continuation_reason'].startswith('User started workflow via /cook:'), 'start action should persist the startup routing outcome in continuation_reason'
assert 'Keep critique details separate from the approval-only proposal summary.' in state['continuation_reason'], 'start action should persist the accepted critique outcome canonically'
PY

# Custom confirmation UI: cancel should exit without writing canonical state and should tell the user
# to discuss changes in the main chat before rerunning /cook.
UI_ROOT_CANCEL="$TMPDIR/ui-root-cancel"
mkdir -p "$UI_ROOT_CANCEL"
cd "$UI_ROOT_CANCEL"
git init -q

UI_SESSION_CANCEL="$TMPDIR/ui-session-cancel.jsonl"
UI_DISCUSSION_CANCEL=$'Mission: Cancel from the custom confirmation UI without writing state.\nScope:\n- Show the proposal separately from the approval-only actions.\nConstraints:\n- Keep cancellation side-effect free.\nAcceptance:\n- Leave .agent absent after cancel.'
UI_ANALYST_OUTPUT_CANCEL='{"mission":"Cancel from the custom confirmation UI without writing state.","scope":["Show the proposal separately from the approval-only actions."],"constraints":["Keep cancellation side-effect free."],"acceptance":["Leave .agent absent after cancel."],"confidence":0.92}'
UI_SNAPSHOT_CANCEL="$TMPDIR/context-proposal-ui-cancel.json"
write_session "$UI_SESSION_CANCEL" "$UI_ROOT_CANCEL" "$UI_DISCUSSION_CANCEL"

PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_ACTION=cancel \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_PATH="$UI_SNAPSHOT_CANCEL" \
PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT="$UI_ANALYST_OUTPUT_CANCEL" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$UI_SESSION_CANCEL" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-ui-cancel.out" 2>"$TMPDIR/pi-completion-context-proposal-ui-cancel.err"

python3 - "$UI_SNAPSHOT_CANCEL" "$TMPDIR/pi-completion-context-proposal-ui-cancel.out" "$TMPDIR/pi-completion-context-proposal-ui-cancel.err" <<'PY'
import json
import sys
from pathlib import Path

snapshot = json.loads(Path(sys.argv[1]).read_text())
output = Path(sys.argv[2]).read_text() + Path(sys.argv[3]).read_text()
assert 'approval-only' in snapshot['intro'], 'cancel snapshot should keep the approval-only intro'
assert [action['id'] for action in snapshot['actions']] == ['start', 'cancel'], 'cancel snapshot should expose Start/Cancel actions only'
assert [action['label'] for action in snapshot['actions']] == ['Start', 'Cancel'], 'cancel snapshot should keep concise Start/Cancel labels'
assert 'Discuss changes in the main chat and rerun /cook.' in snapshot['actions'][1]['description'], 'cancel action copy should redirect users back to the main chat and rerun /cook'
assert 'Discuss changes in the main chat and rerun /cook.' in output, 'cancel command output should redirect users back to the main chat and rerun /cook'
assert not Path('.agent').exists(), 'cancel action should not write canonical workflow state'
PY

echo "context proposal test passed: $ROOT"
