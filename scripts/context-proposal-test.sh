#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi() {
  command pi --no-extensions "$@"
}
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

# No workflow yet: bare /cook should fail closed when a required structured section is missing and analyst output is unavailable.
SESSION_ZERO_MISSING="$TMPDIR/session-zero-missing-section.jsonl"
DISCUSSION_ZERO_MISSING=$'Mission: Remove the completion status line while keeping the completion widget.\nScope:\n- Keep the non-running completion widget.\n- Suppress the widget while a completion role is active.\nConstraints:\n- Do not reintroduce any other completion status surface.'
DISCUSSION_SNAPSHOT_ZERO_MISSING="$TMPDIR/context-proposal-missing-section.json"
write_session "$SESSION_ZERO_MISSING" "$ROOT" "$DISCUSSION_ZERO_MISSING"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_MISSING" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_MISSING" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-missing-section.out" 2>"$TMPDIR/pi-completion-context-proposal-missing-section.err"

python3 - "$TMPDIR/pi-completion-context-proposal-missing-section.out" "$TMPDIR/pi-completion-context-proposal-missing-section.err" "$DISCUSSION_SNAPSHOT_ZERO_MISSING" <<'PY'
import sys
from pathlib import Path

output = Path(sys.argv[1]).read_text() + Path(sys.argv[2]).read_text()
snapshot = Path(sys.argv[3])
assert not Path('.agent').exists(), 'missing-section structured discussion should fail closed without writing canonical state'
assert not snapshot.exists(), 'missing-section structured discussion should not emit a proposal snapshot when bare /cook fails closed'
assert '/cook failed closed' in output, 'missing-section structured discussion should explain the fail-closed startup outcome'
assert 'Mission/Scope/Constraints/Acceptance' in output, 'missing-section structured discussion should explain the strict fallback requirement'
PY

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
assert '/cook failed closed' in output, 'ambiguous structured discussion should explain the fail-closed startup outcome'
assert 'Mission/Scope/Constraints/Acceptance' in output, 'ambiguous structured discussion should explain the strict fallback requirement'
PY

# No workflow yet: bare /cook structured fallback should normalize placeholder planning phrasing
# into the concrete implementation mission when scope/acceptance clearly describe shipped work.
SESSION_ZERO_NORMALIZED="$TMPDIR/session-zero-normalized.jsonl"
DISCUSSION_ZERO_NORMALIZED=$'Mission: 開始實作這個方案\nScope:\n- Normalize bare /cook planning phrasing into shipped implementation missions.\n- Keep analyst-derived and structured-fallback proposals aligned.\nConstraints:\n- Do not rewrite the supported bare-discussion mission anchor once it is clear.\nAcceptance:\n- Add deterministic regression coverage for startup normalization and refocus gating.\n- Keep the approval-only Start/Cancel rewrite gate.'
DISCUSSION_SNAPSHOT_ZERO_NORMALIZED="$TMPDIR/context-proposal-normalized-fallback.json"
write_session "$SESSION_ZERO_NORMALIZED" "$ROOT" "$DISCUSSION_ZERO_NORMALIZED"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_NORMALIZED" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_NORMALIZED" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-normalized-fallback.out" 2>"$TMPDIR/pi-completion-context-proposal-normalized-fallback.err"

python3 - "$DISCUSSION_SNAPSHOT_ZERO_NORMALIZED" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Normalize bare /cook planning phrasing into shipped implementation missions.'
proposal = json.loads(Path(sys.argv[1]).read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())
mission_text = Path('.agent/mission.md').read_text()

assert mission in mission_text, 'normalized structured-fallback startup should update .agent/mission.md to the implementation mission'
assert proposal['mission'] == mission, 'structured-fallback startup should normalize the placeholder planning mission'
assert state['mission_anchor'] == mission, 'state.json mission_anchor should use the normalized implementation mission'
assert plan['mission_anchor'] == mission, 'plan.json mission_anchor should use the normalized implementation mission'
assert active['mission_anchor'] == mission, 'active-slice.json mission_anchor should use the normalized implementation mission'
assert proposal['source'] == 'session', 'normalized structured-fallback startup should still record session fallback as the proposal source'
assert proposal['scope'][0] == mission, 'normalized structured-fallback startup should derive the mission from shipped-work scope'
PY

rm -rf .agent

# No workflow yet: analyst-derived and strict structured fallback proposals should converge on the same
# normalized implementation mission for the same planning-phrased discussion.
SESSION_ZERO_ANALYST_NORMALIZED="$TMPDIR/session-zero-analyst-normalized.jsonl"
ANALYST_OUTPUT_ZERO_NORMALIZED='{"mission":"開始實作這個方案","scope":["Normalize bare /cook planning phrasing into shipped implementation missions.","Keep analyst-derived and structured-fallback proposals aligned."],"constraints":["Do not rewrite the supported bare-discussion mission anchor once it is clear."],"acceptance":["Add deterministic regression coverage for startup normalization and refocus gating.","Keep the approval-only Start/Cancel rewrite gate."],"task_type":"completion-workflow","evaluation_profile":"completion-rubric-v1","confidence":0.93}'
DISCUSSION_SNAPSHOT_ZERO_ANALYST_NORMALIZED="$TMPDIR/context-proposal-normalized-analyst.json"
write_session "$SESSION_ZERO_ANALYST_NORMALIZED" "$ROOT" "$DISCUSSION_ZERO_NORMALIZED"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT="$ANALYST_OUTPUT_ZERO_NORMALIZED" \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_ANALYST_NORMALIZED" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_ANALYST_NORMALIZED" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-normalized-analyst.out" 2>"$TMPDIR/pi-completion-context-proposal-normalized-analyst.err"

python3 - "$DISCUSSION_SNAPSHOT_ZERO_ANALYST_NORMALIZED" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Normalize bare /cook planning phrasing into shipped implementation missions.'
proposal = json.loads(Path(sys.argv[1]).read_text())
state = json.loads(Path('.agent/state.json').read_text())

assert proposal['mission'] == mission, 'analyst-derived startup should normalize the same placeholder planning mission to the same implementation mission'
assert state['mission_anchor'] == mission, 'analyst-derived startup should converge on the same canonical mission anchor as structured fallback'
assert proposal['analysis']['taskType'] == 'completion-workflow', 'analyst-derived normalization should preserve task_type hints'
assert proposal['analysis']['evaluationProfile'] == 'completion-rubric-v1', 'analyst-derived normalization should preserve evaluation_profile hints'
PY

rm -rf .agent

# No workflow yet: planning-artifact-only context should fail closed even when the discussion is
# clearly structured, because bare /cook now expects execution-ready repo changes.
SESSION_ZERO_PLANNING_ONLY="$TMPDIR/session-zero-planning-only.jsonl"
DISCUSSION_ZERO_PLANNING_ONLY=$'Mission: 開始實作這個方案\nScope:\n- Draft the migration plan for the /cook mission-normalization rollout.\nConstraints:\n- Docs only; do not implement runtime changes.\nAcceptance:\n- Produce the proposal text for review.'
DISCUSSION_SNAPSHOT_ZERO_PLANNING_ONLY="$TMPDIR/context-proposal-planning-only.json"
write_session "$SESSION_ZERO_PLANNING_ONLY" "$ROOT" "$DISCUSSION_ZERO_PLANNING_ONLY"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_PLANNING_ONLY" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_PLANNING_ONLY" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-planning-only.out" 2>"$TMPDIR/pi-completion-context-proposal-planning-only.err"

python3 - "$TMPDIR/pi-completion-context-proposal-planning-only.out" "$TMPDIR/pi-completion-context-proposal-planning-only.err" "$DISCUSSION_SNAPSHOT_ZERO_PLANNING_ONLY" <<'PY'
import sys
from pathlib import Path

output = Path(sys.argv[1]).read_text() + Path(sys.argv[2]).read_text()
snapshot = Path(sys.argv[3])
assert not Path('.agent').exists(), 'planning-only startup should fail closed without writing canonical state'
assert not snapshot.exists(), 'planning-only startup should not emit a proposal snapshot when bare /cook fails closed'
assert '/cook failed closed' in output, 'planning-only startup should explain the fail-closed startup outcome'
assert 'Mission/Scope/Constraints/Acceptance' in output, 'planning-only startup should still explain the structured discussion requirement'
assert 'concrete repo changes' in output, 'planning-only startup should explain that bare /cook now expects execution-ready repo changes'
PY

# No workflow yet: docs-only tracked deliverables such as README/CHANGELOG updates should
# normalize placeholder planning missions into concrete repo-change missions.
SESSION_ZERO_SUPPORT_DOCS_ONLY="$TMPDIR/session-zero-support-docs-only.jsonl"
DISCUSSION_ZERO_SUPPORT_DOCS_ONLY=$'Mission: 開始實作這個方案\nScope:\n- Update README and CHANGELOG for the /cook mission-normalization behavior.\nConstraints:\n- Keep the approval-only Start/Cancel gate unchanged.\nAcceptance:\n- Add documentation for the operator-facing refocus flow.'
DISCUSSION_SNAPSHOT_ZERO_SUPPORT_DOCS_ONLY="$TMPDIR/context-proposal-support-docs-only.json"
write_session "$SESSION_ZERO_SUPPORT_DOCS_ONLY" "$ROOT" "$DISCUSSION_ZERO_SUPPORT_DOCS_ONLY"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_SUPPORT_DOCS_ONLY" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_SUPPORT_DOCS_ONLY" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-support-docs-only.out" 2>"$TMPDIR/pi-completion-context-proposal-support-docs-only.err"

python3 - "$DISCUSSION_SNAPSHOT_ZERO_SUPPORT_DOCS_ONLY" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Update README and CHANGELOG for the /cook mission-normalization behavior.'
proposal = json.loads(Path(sys.argv[1]).read_text())
state = json.loads(Path('.agent/state.json').read_text())

assert proposal['mission'] == mission, 'docs-only startup should normalize the placeholder planning mission to the tracked-doc repo change'
assert state['mission_anchor'] == mission, 'docs-only startup should write the normalized tracked-doc mission into canonical state'
assert proposal['scope'][0] == mission, 'docs-only startup should derive the mission from the tracked-doc scope item'
assert proposal['acceptance'] == ['Add documentation for the operator-facing refocus flow.'], 'docs-only startup should keep the documentation acceptance item'
PY

rm -rf .agent

# No workflow yet: reviewer-reproduced docs-only phrasing with edit/document wording should
# also normalize placeholder planning missions into concrete repo-change missions.
SESSION_ZERO_EDIT_DOCUMENT_DOCS_ONLY="$TMPDIR/session-zero-edit-document-docs-only.jsonl"
DISCUSSION_ZERO_EDIT_DOCUMENT_DOCS_ONLY=$'Mission: 開始實作這個方案\nScope:\n- Edit README to explain the /cook mission-normalization behavior.\nConstraints:\n- Keep the approval-only Start/Cancel gate unchanged.\nAcceptance:\n- Document the operator-facing refocus flow.'
DISCUSSION_SNAPSHOT_ZERO_EDIT_DOCUMENT_DOCS_ONLY="$TMPDIR/context-proposal-edit-document-docs-only.json"
write_session "$SESSION_ZERO_EDIT_DOCUMENT_DOCS_ONLY" "$ROOT" "$DISCUSSION_ZERO_EDIT_DOCUMENT_DOCS_ONLY"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_EDIT_DOCUMENT_DOCS_ONLY" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_EDIT_DOCUMENT_DOCS_ONLY" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-edit-document-docs-only.out" 2>"$TMPDIR/pi-completion-context-proposal-edit-document-docs-only.err"

python3 - "$DISCUSSION_SNAPSHOT_ZERO_EDIT_DOCUMENT_DOCS_ONLY" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Edit README to explain the /cook mission-normalization behavior.'
proposal = json.loads(Path(sys.argv[1]).read_text())
state = json.loads(Path('.agent/state.json').read_text())

assert proposal['mission'] == mission, 'edit/document docs-only startup should normalize the placeholder planning mission to the tracked-doc repo change'
assert state['mission_anchor'] == mission, 'edit/document docs-only startup should write the normalized tracked-doc mission into canonical state'
assert proposal['scope'][0] == mission, 'edit/document docs-only startup should derive the mission from the tracked-doc scope item'
assert proposal['acceptance'] == ['Document the operator-facing refocus flow.'], 'edit/document docs-only startup should keep the documentation acceptance item'
PY

rm -rf .agent

# No workflow yet: acceptance-only docs deliverables using write phrasing should also
# normalize placeholder planning missions into concrete repo-change missions.
SESSION_ZERO_WRITE_DOCS_ONLY="$TMPDIR/session-zero-write-docs-only.jsonl"
DISCUSSION_ZERO_WRITE_DOCS_ONLY=$'Mission: 開始實作這個方案\nScope:\n- README and CHANGELOG guidance for bare /cook.\nConstraints:\n- Keep the approval-only Start/Cancel gate unchanged.\nAcceptance:\n- Write README and CHANGELOG notes for the bare /cook fail-closed clarification path.'
DISCUSSION_SNAPSHOT_ZERO_WRITE_DOCS_ONLY="$TMPDIR/context-proposal-write-docs-only.json"
write_session "$SESSION_ZERO_WRITE_DOCS_ONLY" "$ROOT" "$DISCUSSION_ZERO_WRITE_DOCS_ONLY"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_WRITE_DOCS_ONLY" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_WRITE_DOCS_ONLY" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-write-docs-only.out" 2>"$TMPDIR/pi-completion-context-proposal-write-docs-only.err"

python3 - "$DISCUSSION_SNAPSHOT_ZERO_WRITE_DOCS_ONLY" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Write README and CHANGELOG notes for the bare /cook fail-closed clarification path.'
proposal = json.loads(Path(sys.argv[1]).read_text())
state = json.loads(Path('.agent/state.json').read_text())

assert proposal['mission'] == mission, 'write docs-only startup should normalize the placeholder planning mission from acceptance-only tracked-doc work'
assert state['mission_anchor'] == mission, 'write docs-only startup should write the acceptance-derived tracked-doc mission into canonical state'
assert proposal['scope'] == ['README and CHANGELOG guidance for bare /cook.'], 'write docs-only startup should preserve the noun-only scope item while deriving the mission from acceptance'
assert proposal['acceptance'] == [mission], 'write docs-only startup should keep the acceptance-derived docs deliverable intact'
PY

rm -rf .agent

# No workflow yet: explicit `Docs only:` tracked-doc scope wording should still
# normalize placeholder planning missions into concrete repo-change missions.
SESSION_ZERO_EXPLICIT_DOCS_ONLY_SCOPE="$TMPDIR/session-zero-explicit-docs-only-scope.jsonl"
DISCUSSION_ZERO_EXPLICIT_DOCS_ONLY_SCOPE=$'Mission: 開始實作這個方案\nScope:\n- Docs only: Update README and CHANGELOG for the /cook mission-normalization behavior.\nConstraints:\n- Keep the approval-only Start/Cancel gate unchanged.\nAcceptance:\n- Keep the operator-facing refocus flow guidance truthful.'
DISCUSSION_SNAPSHOT_ZERO_EXPLICIT_DOCS_ONLY_SCOPE="$TMPDIR/context-proposal-explicit-docs-only-scope.json"
write_session "$SESSION_ZERO_EXPLICIT_DOCS_ONLY_SCOPE" "$ROOT" "$DISCUSSION_ZERO_EXPLICIT_DOCS_ONLY_SCOPE"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_EXPLICIT_DOCS_ONLY_SCOPE" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_EXPLICIT_DOCS_ONLY_SCOPE" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-explicit-docs-only-scope.out" 2>"$TMPDIR/pi-completion-context-proposal-explicit-docs-only-scope.err"

python3 - "$DISCUSSION_SNAPSHOT_ZERO_EXPLICIT_DOCS_ONLY_SCOPE" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Update README and CHANGELOG for the /cook mission-normalization behavior.'
proposal = json.loads(Path(sys.argv[1]).read_text())
state = json.loads(Path('.agent/state.json').read_text())

assert proposal['mission'] == mission, 'explicit docs only scope should strip the docs-only qualifier while normalizing to the tracked-doc repo change'
assert state['mission_anchor'] == mission, 'explicit docs only scope should write the stripped tracked-doc mission into canonical state'
assert proposal['scope'] == ['Docs only: Update README and CHANGELOG for the /cook mission-normalization behavior.'], 'explicit docs only scope should preserve the original scope wording in the proposal body'
assert proposal['acceptance'] == ['Keep the operator-facing refocus flow guidance truthful.'], 'explicit docs only scope should preserve the non-mission acceptance item'
PY

rm -rf .agent

# No workflow yet: explicit `Documentation only:` tracked-doc acceptance wording should also
# normalize placeholder planning missions into concrete repo-change missions.
SESSION_ZERO_EXPLICIT_DOCUMENTATION_ONLY_ACCEPTANCE="$TMPDIR/session-zero-explicit-documentation-only-acceptance.jsonl"
DISCUSSION_ZERO_EXPLICIT_DOCUMENTATION_ONLY_ACCEPTANCE=$'Mission: 開始實作這個方案\nScope:\n- README and CHANGELOG guidance for bare /cook.\nConstraints:\n- Keep the approval-only Start/Cancel gate unchanged.\nAcceptance:\n- Documentation only: Write README and CHANGELOG notes for the bare /cook fail-closed clarification path.'
DISCUSSION_SNAPSHOT_ZERO_EXPLICIT_DOCUMENTATION_ONLY_ACCEPTANCE="$TMPDIR/context-proposal-explicit-documentation-only-acceptance.json"
write_session "$SESSION_ZERO_EXPLICIT_DOCUMENTATION_ONLY_ACCEPTANCE" "$ROOT" "$DISCUSSION_ZERO_EXPLICIT_DOCUMENTATION_ONLY_ACCEPTANCE"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_EXPLICIT_DOCUMENTATION_ONLY_ACCEPTANCE" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_EXPLICIT_DOCUMENTATION_ONLY_ACCEPTANCE" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-explicit-documentation-only-acceptance.out" 2>"$TMPDIR/pi-completion-context-proposal-explicit-documentation-only-acceptance.err"

python3 - "$DISCUSSION_SNAPSHOT_ZERO_EXPLICIT_DOCUMENTATION_ONLY_ACCEPTANCE" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Write README and CHANGELOG notes for the bare /cook fail-closed clarification path.'
proposal = json.loads(Path(sys.argv[1]).read_text())
state = json.loads(Path('.agent/state.json').read_text())

assert proposal['mission'] == mission, 'explicit documentation only acceptance should strip the docs-only qualifier while normalizing to the tracked-doc repo change'
assert state['mission_anchor'] == mission, 'explicit documentation only acceptance should write the stripped tracked-doc mission into canonical state'
assert proposal['scope'] == ['README and CHANGELOG guidance for bare /cook.'], 'explicit documentation only acceptance should preserve the noun-only scope item while deriving the mission from acceptance'
assert proposal['acceptance'] == ['Documentation only: Write README and CHANGELOG notes for the bare /cook fail-closed clarification path.'], 'explicit documentation only acceptance should preserve the original acceptance wording in the proposal body'
PY

rm -rf .agent

# No workflow yet: assistant-authored completed-plan summaries should fail closed instead of
# seeding startup proposals when the user has not restated an execution-ready mission.
SESSION_ZERO_ASSISTANT_SUMMARY="$TMPDIR/session-zero-assistant-summary.jsonl"
DISCUSSION_SNAPSHOT_ZERO_ASSISTANT_SUMMARY="$TMPDIR/context-proposal-assistant-summary.json"
python3 - "$SESSION_ZERO_ASSISTANT_SUMMARY" "$ROOT" <<'PY'
import json
import sys
from pathlib import Path

session_path = Path(sys.argv[1])
cwd = sys.argv[2]
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
        "id": "b2c3d4e5",
        "parentId": None,
        "timestamp": "2026-01-01T00:00:02.000Z",
        "message": {
            "role": "assistant",
            "content": "Mission: Ship the replacement workflow from the completed plan.\nScope:\n- Rewrite bare /cook around the finished plan summary.\nConstraints:\n- Keep the approval-only Start/Cancel gate unchanged.\nAcceptance:\n- Start immediately from this summary without more user clarification.",
            "timestamp": 1767225602000,
        },
    },
]
with session_path.open('w', encoding='utf-8') as fh:
    for entry in entries:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
PY

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_ASSISTANT_SUMMARY" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_ASSISTANT_SUMMARY" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-assistant-summary.out" 2>"$TMPDIR/pi-completion-context-proposal-assistant-summary.err"

python3 - "$TMPDIR/pi-completion-context-proposal-assistant-summary.out" "$TMPDIR/pi-completion-context-proposal-assistant-summary.err" "$DISCUSSION_SNAPSHOT_ZERO_ASSISTANT_SUMMARY" <<'PY'
import sys
from pathlib import Path

output = Path(sys.argv[1]).read_text() + Path(sys.argv[2]).read_text()
snapshot = Path(sys.argv[3])
assert not Path('.agent').exists(), 'assistant-only startup summary should fail closed without writing canonical state'
assert not snapshot.exists(), 'assistant-only startup summary should not emit a proposal snapshot when bare /cook fails closed'
assert '/cook failed closed' in output, 'assistant-only startup summary should explain the fail-closed startup outcome'
assert 'concrete repo changes' in output, 'assistant-only startup summary should explain that bare /cook expects execution-ready repo changes from main-chat discussion'
PY

rm -rf .agent

# No workflow yet: analyst-derived generic planning missions should still fail closed when discussion
# never provides a clear implementation anchor, instead of promoting vague non-doc scope.
SESSION_ZERO_ANALYST_AMBIGUOUS_GENERIC="$TMPDIR/session-zero-analyst-ambiguous-generic.jsonl"
DISCUSSION_ZERO_ANALYST_AMBIGUOUS_GENERIC=$'We should revisit the completion widget while roles are active and make the outcome easier to follow without deciding the exact implementation yet.'
ANALYST_OUTPUT_ZERO_AMBIGUOUS_GENERIC='{"mission":"開始實作這個方案","scope":["The completion widget during active roles."],"constraints":["Keep the approval-only Start/Cancel gate unchanged."],"acceptance":["Current behavior stays understandable."],"task_type":"completion-workflow","evaluation_profile":"completion-rubric-v1","confidence":0.74}'
DISCUSSION_SNAPSHOT_ZERO_ANALYST_AMBIGUOUS_GENERIC="$TMPDIR/context-proposal-analyst-ambiguous-generic.json"
write_session "$SESSION_ZERO_ANALYST_AMBIGUOUS_GENERIC" "$ROOT" "$DISCUSSION_ZERO_ANALYST_AMBIGUOUS_GENERIC"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT="$ANALYST_OUTPUT_ZERO_AMBIGUOUS_GENERIC" \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_ZERO_ANALYST_AMBIGUOUS_GENERIC" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ZERO_ANALYST_AMBIGUOUS_GENERIC" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-analyst-ambiguous-generic.out" 2>"$TMPDIR/pi-completion-context-proposal-analyst-ambiguous-generic.err"

python3 - "$TMPDIR/pi-completion-context-proposal-analyst-ambiguous-generic.out" "$TMPDIR/pi-completion-context-proposal-analyst-ambiguous-generic.err" "$DISCUSSION_SNAPSHOT_ZERO_ANALYST_AMBIGUOUS_GENERIC" <<'PY'
import sys
from pathlib import Path

output = Path(sys.argv[1]).read_text() + Path(sys.argv[2]).read_text()
snapshot = Path(sys.argv[3])
assert not Path('.agent').exists(), 'analyst-derived ambiguous generic discussion should fail closed without writing canonical state'
assert not snapshot.exists(), 'analyst-derived ambiguous generic discussion should not emit a proposal snapshot when bare /cook fails closed'
assert '/cook failed closed' in output, 'analyst-derived ambiguous generic discussion should explain the fail-closed startup outcome'
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

# Active workflow: bare /cook with matching structured discussion should classify as continue
# and resume the current workflow without opening the chooser or rewriting canonical state.
SESSION_ONE_CONTINUE="$TMPDIR/session-one-continue.jsonl"
DISCUSSION_ONE_CONTINUE=$'Mission: Remove the completion status line while keeping the completion widget.\nScope:\n- Keep the current mission focused on the non-running completion widget.\nConstraints:\n- Do not start a different workflow from this discussion.\nAcceptance:\n- Resume the current workflow from canonical state without rewriting it.'
CONTINUE_ROUTING_ONE="$TMPDIR/active-continue-routing.json"
CONTINUE_RESUME_PROMPT_ONE="$TMPDIR/active-continue-resume.txt"
CONTINUE_CHOOSER_ONE="$TMPDIR/unexpected-active-continue-chooser.json"
write_session "$SESSION_ONE_CONTINUE" "$ROOT" "$DISCUSSION_ONE_CONTINUE"

PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH="$CONTINUE_ROUTING_ONE" \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$CONTINUE_RESUME_PROMPT_ONE" \
PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH="$CONTINUE_CHOOSER_ONE" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ONE_CONTINUE" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-active-continue.out" 2>"$TMPDIR/pi-completion-context-proposal-active-continue.err"

python3 - "$CONTINUE_ROUTING_ONE" "$CONTINUE_RESUME_PROMPT_ONE" "$CONTINUE_CHOOSER_ONE" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Remove the completion status line while keeping the completion widget.'
routing = json.loads(Path(sys.argv[1]).read_text())
resume = Path(sys.argv[2]).read_text()
chooser_path = Path(sys.argv[3])
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert routing['mode'] == 'bare', 'active bare /cook continue regression should snapshot bare routing mode'
assert 'explicitGoal' not in routing, 'active bare /cook continue routing should not expose removed explicit-goal shim fields'
assert 'explicitGoalProvided' not in routing, 'active bare /cook continue routing should not expose removed explicit-goal shim fields'
assert routing['action'] == 'continue', 'matching structured discussion should classify active bare /cook as continue'
assert routing['reason'] == 'matching_mission', 'matching structured discussion should keep the current mission rather than refocus'
assert routing['currentMissionAnchor'] == mission, 'continue routing should preserve the current mission anchor'
assert routing['proposedMissionAnchor'] == mission, 'continue routing should keep the proposed mission anchored to the current mission'
assert 'Resume the completion workflow from canonical state.' in resume, 'active bare /cook continue should still use the canonical resume prompt'
assert not chooser_path.exists(), 'active bare /cook continue should not open the refocus chooser'
assert state['mission_anchor'] == mission, 'active bare /cook continue should keep state.json unchanged'
assert plan['mission_anchor'] == mission, 'active bare /cook continue should keep plan.json unchanged'
assert active['mission_anchor'] == mission, 'active bare /cook continue should keep active-slice.json unchanged'
PY

# Active workflow: summary-only replacement artifacts should fail closed and keep the current
# workflow instead of opening the refocus chooser.
SESSION_ONE_SUMMARY_ONLY="$TMPDIR/session-one-summary-only.jsonl"
SUMMARY_ROUTING_ONE="$TMPDIR/active-summary-only-routing.json"
SUMMARY_RESUME_PROMPT_ONE="$TMPDIR/active-summary-only-resume.txt"
SUMMARY_CHOOSER_ONE="$TMPDIR/unexpected-active-summary-only-chooser.json"
SUMMARY_PROPOSAL_ONE="$TMPDIR/unexpected-active-summary-only-proposal.json"
python3 - "$SESSION_ONE_SUMMARY_ONLY" "$ROOT" <<'PY'
import json
import sys
from pathlib import Path

session_path = Path(sys.argv[1])
cwd = sys.argv[2]
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
        "id": "c3d4e5f6",
        "parentId": None,
        "timestamp": "2026-01-01T00:00:03.000Z",
        "message": {
            "role": "branchSummary",
            "summary": "Mission: Replace the current workflow from the completed plan summary.\nScope:\n- Refocus to a different mission from this summary artifact alone.\nConstraints:\n- Keep the approval-only Start/Cancel gate unchanged.\nAcceptance:\n- Rewrite canonical state from the summary without new user discussion.",
        },
    },
]
with session_path.open('w', encoding='utf-8') as fh:
    for entry in entries:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
PY

PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH="$SUMMARY_ROUTING_ONE" \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$SUMMARY_RESUME_PROMPT_ONE" \
PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH="$SUMMARY_CHOOSER_ONE" \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$SUMMARY_PROPOSAL_ONE" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ONE_SUMMARY_ONLY" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-active-summary-only.out" 2>"$TMPDIR/pi-completion-context-proposal-active-summary-only.err"

python3 - "$SUMMARY_ROUTING_ONE" "$SUMMARY_RESUME_PROMPT_ONE" "$SUMMARY_CHOOSER_ONE" "$SUMMARY_PROPOSAL_ONE" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Remove the completion status line while keeping the completion widget.'
routing = json.loads(Path(sys.argv[1]).read_text())
resume = Path(sys.argv[2]).read_text()
chooser_path = Path(sys.argv[3])
proposal_path = Path(sys.argv[4])
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert routing['mode'] == 'bare', 'summary-only active bare /cook regression should snapshot bare routing mode'
assert routing['action'] == 'unclear', 'summary-only active bare /cook should fail closed instead of refocusing'
assert routing['reason'] == 'missing_proposal', 'summary-only active bare /cook should treat the summary artifact as unreadiness, not a new proposal'
assert routing['currentMissionAnchor'] == mission, 'summary-only active bare /cook should preserve the current mission anchor'
assert routing['proposedMissionAnchor'] is None, 'summary-only active bare /cook should not derive a replacement mission from summary artifacts alone'
assert 'Resume the completion workflow from canonical state.' in resume, 'summary-only active bare /cook should still resume the canonical workflow'
assert not chooser_path.exists(), 'summary-only active bare /cook should not open the refocus chooser'
assert not proposal_path.exists(), 'summary-only active bare /cook should not open replacement proposal confirmation'
assert state['mission_anchor'] == mission, 'summary-only active bare /cook should keep state.json unchanged'
assert plan['mission_anchor'] == mission, 'summary-only active bare /cook should keep plan.json unchanged'
assert active['mission_anchor'] == mission, 'summary-only active bare /cook should keep active-slice.json unchanged'
PY

# Active workflow: bare /cook with a placeholder planning mission should still route through the existing
# refocus chooser and final Start/Cancel gate before canonical state is rewritten.
SESSION_ONE_REFOCUS_NORMALIZED="$TMPDIR/session-one-refocus-normalized.jsonl"
DISCUSSION_ONE_REFOCUS_NORMALIZED=$'Mission: 開始實作這個方案\nScope:\n- Normalize bare /cook planning phrasing into implementation-result missions.\n- Keep the approval-only Start/Cancel gate before rewriting canonical state.\nConstraints:\n- Do not resume the current widget mission.\nAcceptance:\n- Route through chooser-driven refocus before rewriting canonical state.'
REFOCUS_ROUTING_ONE="$TMPDIR/active-refocus-routing.json"
REFOCUS_CHOOSER_ONE="$TMPDIR/active-refocus-chooser.json"
REFOCUS_PROPOSAL_ONE="$TMPDIR/active-refocus-proposal.json"
REFOCUS_UI_ONE="$TMPDIR/active-refocus-ui.json"
write_session "$SESSION_ONE_REFOCUS_NORMALIZED" "$ROOT" "$DISCUSSION_ONE_REFOCUS_NORMALIZED"

PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_ACTION=start \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH="$REFOCUS_ROUTING_ONE" \
PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH="$REFOCUS_CHOOSER_ONE" \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$REFOCUS_PROPOSAL_ONE" \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_UI_PATH="$REFOCUS_UI_ONE" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_ONE_REFOCUS_NORMALIZED" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-active-refocus-normalized.out" 2>"$TMPDIR/pi-completion-context-proposal-active-refocus-normalized.err"

python3 - "$REFOCUS_ROUTING_ONE" "$REFOCUS_CHOOSER_ONE" "$REFOCUS_PROPOSAL_ONE" "$REFOCUS_UI_ONE" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Normalize bare /cook planning phrasing into implementation-result missions.'
routing = json.loads(Path(sys.argv[1]).read_text())
chooser = json.loads(Path(sys.argv[2]).read_text())
proposal = json.loads(Path(sys.argv[3]).read_text())
ui = json.loads(Path(sys.argv[4]).read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert routing['mode'] == 'bare', 'active bare /cook refocus normalization should snapshot bare routing mode'
assert 'explicitGoal' not in routing, 'active bare /cook refocus routing should not expose removed explicit-goal shim fields'
assert 'explicitGoalProvided' not in routing, 'active bare /cook refocus routing should not expose removed explicit-goal shim fields'
assert routing['action'] == 'refocus', 'placeholder planning mission should still classify active bare /cook as refocus when the normalized mission changes'
assert routing['reason'] == 'clear_refocus', 'active bare /cook refocus normalization should keep the clear_refocus routing reason'
assert routing['proposedMissionAnchor'] == mission, 'active bare /cook refocus should normalize the proposed mission before canonical rewrite'
assert chooser['choices'][1].startswith('Start new workflow from recent discussion'), 'active bare /cook refocus should still route through the existing chooser copy before rewrite'
assert [action['id'] for action in ui['actions']] == ['start', 'cancel'], 'active bare /cook refocus should still end at the approval-only Start/Cancel gate'
assert proposal['mission'] == mission, 'active bare /cook refocus proposal snapshot should expose the normalized implementation mission'
assert state['mission_anchor'] == mission, 'active bare /cook refocus should rewrite canonical state to the normalized mission only after approval'
assert plan['mission_anchor'] == mission, 'active bare /cook refocus should rewrite plan.json only after approval'
assert active['mission_anchor'] == mission, 'active bare /cook refocus should rewrite active-slice.json only after approval'
PY

# Completed workflow: bare /cook should normalize placeholder planning phrasing for the next workflow
# round too, not only for fresh startup.
mark_done

SESSION_TWO_NORMALIZED="$TMPDIR/session-two-normalized.jsonl"
DISCUSSION_TWO_NORMALIZED=$'Mission: 開始實作這個方案\nScope:\n- Normalize bare /cook planning phrasing for the next workflow round.\n- Reset canonical state for the new implementation mission.\nConstraints:\n- Do not resume the completed workflow when the new round is clearly different.\nAcceptance:\n- Start a new round with the normalized mission anchor.'
DISCUSSION_SNAPSHOT_TWO_NORMALIZED="$TMPDIR/context-proposal-next-round-normalized.json"
write_session "$SESSION_TWO_NORMALIZED" "$ROOT" "$DISCUSSION_TWO_NORMALIZED"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DISCUSSION_SNAPSHOT_TWO_NORMALIZED" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$SESSION_TWO_NORMALIZED" -e "$PKG_ROOT" -p "/cook" >"$TMPDIR/pi-completion-context-proposal-next-round-normalized.out" 2>"$TMPDIR/pi-completion-context-proposal-next-round-normalized.err"

python3 - "$DISCUSSION_SNAPSHOT_TWO_NORMALIZED" <<'PY'
import json
import sys
from pathlib import Path

mission = 'Normalize bare /cook planning phrasing for the next workflow round.'
proposal = json.loads(Path(sys.argv[1]).read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert proposal['mission'] == mission, 'done-workflow structured fallback should normalize the placeholder planning mission for the next round'
assert state['mission_anchor'] == mission, 'done-workflow startup should rewrite canonical state to the normalized next-round mission'
assert plan['mission_anchor'] == mission, 'done-workflow startup should rewrite plan.json to the normalized next-round mission'
assert active['mission_anchor'] == mission, 'done-workflow startup should rewrite active-slice.json to the normalized next-round mission'
assert state['continuation_reason'].startswith('User refocused workflow via /cook:'), 'done-workflow normalization should still route through refocus semantics for the next round'
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

# Active workflow: /cook <text> should be rejected before routing or proposal confirmation
# and still leave canonical state unchanged.
ACTIVE_INLINE_REJECTION_ROUTING="$TMPDIR/context-proposal-active-inline-arg-routing.json"
ACTIVE_INLINE_REJECTION_PROPOSAL="$TMPDIR/context-proposal-active-inline-arg-proposal.json"
ACTIVE_INLINE_REJECTION_CHOOSER="$TMPDIR/context-proposal-active-inline-arg-chooser.json"
ACTIVE_INLINE_REJECTION_BASELINE="$TMPDIR/context-proposal-active-inline-before.json"
python3 - "$ACTIVE_INLINE_REJECTION_BASELINE" <<'PY'
import json
import sys
from pathlib import Path

tracked = [
    Path('.agent/mission.md'),
    Path('.agent/profile.json'),
    Path('.agent/state.json'),
    Path('.agent/plan.json'),
    Path('.agent/active-slice.json'),
    Path('.agent/verification-evidence.json'),
]
Path(sys.argv[1]).write_text(json.dumps({path.name: path.read_text() for path in tracked}, indent=2) + '\n')
PY

PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=cancel \
PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT='{"mission":"Replacement mission for the active workflow.","scope":["Review the replacement through the existing workflow chooser first."],"constraints":["Do not rewrite canonical state before the final Start confirmation."],"acceptance":["Show the final replacement proposal only after the chooser selects refocus."],"task_type":"completion-workflow","evaluation_profile":"completion-rubric-v1","confidence":0.9}' \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$ACTIVE_INLINE_REJECTION_PROPOSAL" \
PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH="$ACTIVE_INLINE_REJECTION_ROUTING" \
PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH="$ACTIVE_INLINE_REJECTION_CHOOSER" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi -e "$PKG_ROOT" -p "/cook Replacement mission for the active workflow" >"$TMPDIR/pi-completion-context-proposal-active-inline-arg.out" 2>"$TMPDIR/pi-completion-context-proposal-active-inline-arg.err"

python3 - "$TMPDIR/pi-completion-context-proposal-active-inline-arg.out" "$TMPDIR/pi-completion-context-proposal-active-inline-arg.err" "$ACTIVE_INLINE_REJECTION_ROUTING" "$ACTIVE_INLINE_REJECTION_PROPOSAL" "$ACTIVE_INLINE_REJECTION_CHOOSER" "$ACTIVE_INLINE_REJECTION_BASELINE" <<'PY'
import json
import sys
from pathlib import Path

output = Path(sys.argv[1]).read_text() + Path(sys.argv[2]).read_text()
routing = Path(sys.argv[3])
proposal = Path(sys.argv[4])
chooser = Path(sys.argv[5])
before = json.loads(Path(sys.argv[6]).read_text())
tracked = [
    Path('.agent/mission.md'),
    Path('.agent/profile.json'),
    Path('.agent/state.json'),
    Path('.agent/plan.json'),
    Path('.agent/active-slice.json'),
    Path('.agent/verification-evidence.json'),
]

assert '/cook only supports the bare /cook entrypoint.' in output, 'active /cook <text> rejection should explain the bare-only contract'
assert not routing.exists(), 'active /cook <text> rejection should not run active-workflow routing'
assert not proposal.exists(), 'active /cook <text> rejection should not open proposal confirmation'
assert not chooser.exists(), 'active /cook <text> rejection should not open the existing-workflow chooser'
after = {path.name: path.read_text() for path in tracked}
assert before == after, 'active /cook <text> rejection should leave canonical files unchanged'
PY

# Completed workflow: /cook <text> should be rejected before any next-round proposal is derived
# and still leave canonical state unchanged.
mark_done

DONE_INLINE_REJECTION_ROUTING="$TMPDIR/context-proposal-done-inline-arg-routing.json"
DONE_INLINE_REJECTION_PROPOSAL="$TMPDIR/context-proposal-done-inline-arg-proposal.json"
DONE_INLINE_REJECTION_CHOOSER="$TMPDIR/context-proposal-done-inline-arg-chooser.json"
DONE_INLINE_REJECTION_BASELINE="$TMPDIR/context-proposal-done-inline-before.json"
python3 - "$DONE_INLINE_REJECTION_BASELINE" <<'PY'
import json
import sys
from pathlib import Path

tracked = [
    Path('.agent/mission.md'),
    Path('.agent/profile.json'),
    Path('.agent/state.json'),
    Path('.agent/plan.json'),
    Path('.agent/active-slice.json'),
    Path('.agent/verification-evidence.json'),
]
Path(sys.argv[1]).write_text(json.dumps({path.name: path.read_text() for path in tracked}, indent=2) + '\n')
PY

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=cancel \
PI_COMPLETION_CONTEXT_PROPOSAL_ANALYST_OUTPUT='{"mission":"Update README guidance for the next workflow round.","scope":["Refresh README guidance for /cook hint-driven startup behavior."],"constraints":["Do not rewrite canonical state before Start is accepted."],"acceptance":["Keep the next-round proposal scoped to README updates only."],"task_type":"completion-workflow","evaluation_profile":"completion-rubric-v1","confidence":0.9}' \
PI_COMPLETION_TEST_CONTEXT_PROPOSAL_PATH="$DONE_INLINE_REJECTION_PROPOSAL" \
PI_COMPLETION_TEST_ACTIVE_WORKFLOW_ROUTING_PATH="$DONE_INLINE_REJECTION_ROUTING" \
PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH="$DONE_INLINE_REJECTION_CHOOSER" \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi -e "$PKG_ROOT" -p "/cook done-workflow replacement mission" >"$TMPDIR/pi-completion-context-proposal-done-inline-arg.out" 2>"$TMPDIR/pi-completion-context-proposal-done-inline-arg.err"

python3 - "$TMPDIR/pi-completion-context-proposal-done-inline-arg.out" "$TMPDIR/pi-completion-context-proposal-done-inline-arg.err" "$DONE_INLINE_REJECTION_ROUTING" "$DONE_INLINE_REJECTION_PROPOSAL" "$DONE_INLINE_REJECTION_CHOOSER" "$DONE_INLINE_REJECTION_BASELINE" <<'PY'
import json
import sys
from pathlib import Path

output = Path(sys.argv[1]).read_text() + Path(sys.argv[2]).read_text()
routing = Path(sys.argv[3])
proposal = Path(sys.argv[4])
chooser = Path(sys.argv[5])
before = json.loads(Path(sys.argv[6]).read_text())
tracked = [
    Path('.agent/mission.md'),
    Path('.agent/profile.json'),
    Path('.agent/state.json'),
    Path('.agent/plan.json'),
    Path('.agent/active-slice.json'),
    Path('.agent/verification-evidence.json'),
]
state_before = json.loads(before['state.json'])
assert state_before['current_phase'] == 'done', 'done /cook <text> rejection should start from a completed workflow'
assert state_before['project_done'] is True, 'done /cook <text> rejection should start from project_done=true'
assert '/cook only supports the bare /cook entrypoint.' in output, 'done /cook <text> rejection should explain the bare-only contract'
assert not routing.exists(), 'done /cook <text> rejection should not run active/done workflow routing'
assert not proposal.exists(), 'done /cook <text> rejection should not open next-round proposal confirmation'
assert not chooser.exists(), 'done /cook <text> rejection should not open the chooser flow'
after = {path.name: path.read_text() for path in tracked}
assert before == after, 'done /cook <text> rejection should leave canonical files unchanged'
PY

# Completed workflow again: /cook with no goal should be able to use model-assisted
# analysis of natural discussion when discussion-only startup depends on analyst output.
mark_done

SESSION_FIVE="$TMPDIR/session-five.jsonl"
DISCUSSION_FIVE=$'I do not want to rewrite the parser. The safer path is to let /cook analyze the discussion first, keep the discussion-derived mission anchored once it is clear, and ignore stale scope that drifted in from earlier turns. We should still prove it with a regression test before writing canonical state.'
ANALYST_OUTPUT_FIVE='{"mission":"Use a proposal analyst to summarize natural discussion before /cook writes canonical state.","scope":["Keep the discussion-derived mission anchored once it is clear.","Drop stale scope from earlier turns."],"constraints":["Do not rewrite the parser."],"acceptance":["Add a regression test."],"confidence":0.91,"possible_noise":["old unrelated scope"]}'
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
assert 'Keep the discussion-derived mission anchored once it is clear.' in continuation_reason, 'analyst-derived scope should be preserved'
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

grep -q 'export async function deriveCookContextProposalFromRecentDiscussion' "$PKG_ROOT/extensions/completion/proposal.ts"
grep -q 'export function parseContextProposalAnalystOutput' "$PKG_ROOT/extensions/completion/proposal.ts"
grep -q 'export function buildContextProposalConfirmationLayout' "$PKG_ROOT/extensions/completion/prompt-surfaces.ts"
grep -q 'export function buildEvaluationRoleContextLines' "$PKG_ROOT/extensions/completion/prompt-surfaces.ts"

echo "context proposal test passed: $ROOT"
