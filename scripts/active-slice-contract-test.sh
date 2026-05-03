#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cd "$PKG_ROOT"

node <<'NODE'
const fs = require('node:fs');

const read = (file) => fs.readFileSync(file, 'utf8');
const assertIncludes = (file, snippet) => {
  const text = read(file);
  if (!text.includes(snippet)) {
    throw new Error(`${file} is missing required active-slice-contract text: ${snippet}`);
  }
};

assertIncludes('agents/completion-implementer.md', 'canonical implementation contract');
assertIncludes('agents/completion-implementer.md', '`implementation_surfaces`');
assertIncludes('agents/completion-implementer.md', '`verification_commands`');
assertIncludes('agents/completion-implementer.md', '`basis_commit`');
assertIncludes('agents/completion-implementer.md', '`remaining_contract_ids_before`');
assertIncludes('agents/completion-implementer.md', '`release_blocker_count_before`');
assertIncludes('agents/completion-implementer.md', '`high_value_gap_count_before`');
assertIncludes('README.md', 'canonical implementation contract for selected, in-progress, committed, and done slices');
assertIncludes('README.md', 'The selected plan slice must mirror that exact contract across goal, contract IDs, acceptance criteria');
assertIncludes('README.md', '`basis_commit`');
assertIncludes('README.md', '`remaining_contract_ids_before` plus `release_blocker_count_before` / `high_value_gap_count_before`');
assertIncludes('README.md', 'Deterministic active-slice contract regression now lives in `bash scripts/active-slice-contract-test.sh`');
assertIncludes('README.md', 'includes deterministic active-slice contract coverage plus observability coverage');
assertIncludes('scripts/release-check.sh', 'bash ./scripts/active-slice-contract-test.sh');
assertIncludes('.agent/verify_completion_stop.sh', 'npm run release-check >/dev/null');
assertIncludes('extensions/completion/index.ts', "const planMirrorFields = ['locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'basis_commit', 'remaining_contract_ids_before', 'release_blocker_count_before', 'high_value_gap_count_before'];");
assertIncludes('extensions/completion/index.ts', 'Selected/in-progress/committed/done .agent/active-slice.json is the canonical implementation contract.');
assertIncludes('extensions/completion/index.ts', 'Active slice contract drift: ${activeContractDrift}');
assertIncludes('extensions/completion/index.ts', 'Canonical active-slice contract drift is currently: ${activeContractDrift}');
assertIncludes('extensions/completion/index.ts', '`active_slice_contract_drift_fields: ${activeContractDrift}`');
assertIncludes('extensions/completion/index.ts', 'treat .agent/active-slice.json as the canonical implementation contract');
assertIncludes('.agent/verify_completion_control_plane.sh', "const planMirrorFields = ['locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'basis_commit', 'remaining_contract_ids_before', 'release_blocker_count_before', 'high_value_gap_count_before'];");
assertIncludes('.agent/verify_completion_control_plane.sh', 'slice_id must match a slice in .agent/plan.json when status carries an exact handoff');
assertIncludes('.agent/verify_completion_control_plane.sh', '.agent/active-slice.json must match the selected .agent/plan.json slice across: ');
NODE

ROOT="$TMPDIR/repo"
PROMPT="$TMPDIR/resume-prompt.txt"
mkdir -p "$ROOT"
cd "$ROOT"
git init -q

PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi -e "$PKG_ROOT" -p "/cook active-slice contract fixture" \
  >"$TMPDIR/pi-active-slice-bootstrap.out" 2>"$TMPDIR/pi-active-slice-bootstrap.err"

python3 - <<'PY'
import json
from pathlib import Path

mission = 'Exercise active-slice contract parity.'
task_type = 'completion-workflow'
evaluation_profile = 'completion-rubric-v1'
verification_commands = [
    'bash .agent/verify_completion_control_plane.sh',
    'bash scripts/active-slice-contract-test.sh',
    'npm run release-check',
]
implementation_surfaces = [
    'extensions/completion/index.ts',
    'agents/completion-implementer.md',
    'README.md',
    '.agent/verify_completion_control_plane.sh',
    'scripts/release-check.sh',
    'scripts/active-slice-contract-test.sh',
]
locked_notes = [
    'Keep scope locked to active-slice contract parity.',
    'Do not broaden into canonical evidence artifacts.',
]
must_fix_findings = [
    'Ensure release-check covers the active-slice contract regression.',
]
remaining_contracts = ['ACTIVE-SLICE-CONTRACT-V2', 'CANONICAL-EVIDENCE-ARTIFACTS']
acceptance = [
    'Selected active-slice data is treated as the canonical implementation contract.',
    'Control-plane parity checks fail closed on active-vs-plan drift.',
    'Release-check includes deterministic active-slice contract regression coverage.',
]

state = {
    'schema_version': 1,
    'mission_anchor': mission,
    'current_phase': 'implement',
    'continuation_policy': 'continue',
    'continuation_reason': 'Fixture for active-slice contract regression coverage.',
    'project_done': False,
    'task_type': task_type,
    'evaluation_profile': evaluation_profile,
    'requires_reground': False,
    'slices_since_last_reground': 0,
    'remaining_release_blockers': 0,
    'remaining_high_value_gaps': 2,
    'unsatisfied_contract_ids': remaining_contracts,
    'release_blocker_ids': [],
    'next_mandatory_action': 'Implement selected slice active-slice-fixture.',
    'next_mandatory_role': 'completion-implementer',
    'remaining_stop_judges': 3,
    'last_reground_at': '2026-05-03T00:00:00Z',
    'last_auditor_verdict': None,
    'contract_status': 'selected_slice_pending_implementation',
    'latest_completed_slice': 'fixturebasis',
    'latest_verified_slice': 'fixturebasis',
}
plan = {
    'schema_version': 1,
    'mission_anchor': mission,
    'task_type': task_type,
    'evaluation_profile': evaluation_profile,
    'last_reground_at': '2026-05-03T00:00:00Z',
    'plan_basis': 'active_slice_contract_fixture',
    'candidate_slices': [
        {
            'slice_id': 'active-slice-fixture',
            'goal': 'Tighten active-slice implementation contract enforcement.',
            'acceptance_criteria': acceptance,
            'contract_ids': ['ACTIVE-SLICE-CONTRACT-V2'],
            'priority': 80,
            'status': 'selected',
            'why_now': 'Fixture for active-slice contract parity.',
            'blocked_on': [],
            'evidence': [],
            'locked_notes': locked_notes,
            'must_fix_findings': must_fix_findings,
            'implementation_surfaces': implementation_surfaces,
            'verification_commands': verification_commands,
            'basis_commit': 'fixturebasis',
            'remaining_contract_ids_before': remaining_contracts,
            'release_blocker_count_before': 0,
            'high_value_gap_count_before': 2,
        }
    ],
}
active = {
    'schema_version': 1,
    'mission_anchor': mission,
    'task_type': task_type,
    'evaluation_profile': evaluation_profile,
    'status': 'selected',
    'slice_id': 'active-slice-fixture',
    'goal': 'Tighten active-slice implementation contract enforcement.',
    'contract_ids': ['ACTIVE-SLICE-CONTRACT-V2'],
    'acceptance_criteria': acceptance,
    'blocked_on': [],
    'locked_notes': locked_notes,
    'must_fix_findings': must_fix_findings,
    'implementation_surfaces': implementation_surfaces,
    'verification_commands': verification_commands,
    'basis_commit': 'fixturebasis',
    'remaining_contract_ids_before': remaining_contracts,
    'release_blocker_count_before': 0,
    'high_value_gap_count_before': 2,
    'priority': 80,
    'why_now': 'Fixture for active-slice contract parity.',
}

Path('.agent/state.json').write_text(json.dumps(state, indent=2) + '\n')
Path('.agent/plan.json').write_text(json.dumps(plan, indent=2) + '\n')
Path('.agent/active-slice.json').write_text(json.dumps(active, indent=2) + '\n')
Path('.agent/verification-evidence.json').write_text(json.dumps({
    'schema_version': 1,
    'artifact_type': 'completion-verification-evidence',
    'subject_type': 'selected_slice',
    'slice_id': active['slice_id'],
    'goal': active['goal'],
    'contract_ids': active['contract_ids'],
    'basis_commit': active['basis_commit'],
    'head_sha': active['basis_commit'],
    'verification_commands': verification_commands,
    'outcome': 'passed',
    'recorded_at': '2026-05-03T00:00:00Z',
    'summary': 'Fixture evidence matches the selected active-slice contract.',
}, indent=2) + '\n')
PY

PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$PROMPT" \
pi -e "$PKG_ROOT" -p "/cook" \
  >"$TMPDIR/pi-active-slice-resume.out" 2>"$TMPDIR/pi-active-slice-resume.err"

python3 - "$PROMPT" <<'PY'
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
assert 'treat .agent/active-slice.json as the canonical implementation contract' in text, text
assert 'drifts from the selected plan slice or the exact handoff is unclear' in text, text
PY

bash .agent/verify_completion_control_plane.sh >/dev/null

python3 - <<'PY'
import copy
import json
import subprocess
from pathlib import Path

plan_path = Path('.agent/plan.json')
base_plan = json.loads(plan_path.read_text())

cases = [
    ('slice_id', lambda slice: slice.__setitem__('slice_id', 'different-slice')),
    ('goal', lambda slice: slice.__setitem__('goal', 'Drifted goal')),
    ('contract_ids', lambda slice: slice.__setitem__('contract_ids', ['OTHER-CONTRACT'])),
    ('acceptance_criteria', lambda slice: slice.__setitem__('acceptance_criteria', ['Different criterion'])),
    ('blocked_on', lambda slice: slice.__setitem__('blocked_on', ['fixture-blocker'])),
    ('priority', lambda slice: slice.__setitem__('priority', 1)),
    ('why_now', lambda slice: slice.__setitem__('why_now', 'Different why_now')),
    ('implementation_surfaces', lambda slice: slice.pop('implementation_surfaces', None)),
    ('verification_commands', lambda slice: slice.__setitem__('verification_commands', ['bash .agent/verify_completion_control_plane.sh'])),
    ('locked_notes', lambda slice: slice.__setitem__('locked_notes', ['different note'])),
    ('must_fix_findings', lambda slice: slice.__setitem__('must_fix_findings', ['different finding'])),
    ('basis_commit', lambda slice: slice.__setitem__('basis_commit', 'differentbasis')),
    ('remaining_contract_ids_before', lambda slice: slice.__setitem__('remaining_contract_ids_before', ['ACTIVE-SLICE-CONTRACT-V2'])),
    ('release_blocker_count_before', lambda slice: slice.__setitem__('release_blocker_count_before', 1)),
    ('high_value_gap_count_before', lambda slice: slice.__setitem__('high_value_gap_count_before', 99)),
]

for label, mutate in cases:
    plan = copy.deepcopy(base_plan)
    slice_data = plan['candidate_slices'][0]
    mutate(slice_data)
    plan_path.write_text(json.dumps(plan, indent=2) + '\n')
    result = subprocess.run(['bash', '.agent/verify_completion_control_plane.sh'], capture_output=True, text=True)
    combined = (result.stdout or '') + (result.stderr or '')
    assert result.returncode != 0, f'expected verifier failure for {label}'
    assert label in combined, f'expected verifier output to mention {label}, got: {combined}'

plan_path.write_text(json.dumps(base_plan, indent=2) + '\n')
PY

echo "active-slice contract test passed: $TMPDIR"
