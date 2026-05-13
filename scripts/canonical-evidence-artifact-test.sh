#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi() {
  env -u PI_COMPLETION_ROLE command pi --no-extensions "$@"
}
TMPDIR="$(mktemp -d)"
CURRENT_EVIDENCE_BACKUP=""

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

cleanup() {
  if [[ -n "$CURRENT_EVIDENCE_BACKUP" && -f "$CURRENT_EVIDENCE_BACKUP" ]]; then
    cp "$CURRENT_EVIDENCE_BACKUP" "$PKG_ROOT/.agent/verification-evidence.json"
  fi
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

cd "$PKG_ROOT"

node <<'NODE'
const fs = require('node:fs');

const read = (file) => fs.readFileSync(file, 'utf8');
const assertIncludes = (file, snippet) => {
  const text = read(file);
  if (!text.includes(snippet)) {
    throw new Error(`${file} is missing required canonical-evidence text: ${snippet}`);
  }
};
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const readSection = (file, heading) => {
  const text = read(file);
  const match = text.match(new RegExp(`^${escapeRegex(heading)}\\s*$\\n([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'm'));
  if (!match) {
    throw new Error(`${file} is missing required section: ${heading}`);
  }
  return match[1];
};
const assertSectionIncludes = (file, heading, snippet) => {
  const section = readSection(file, heading);
  if (!section.includes(snippet)) {
    throw new Error(`${file} section ${heading} is missing required canonical-evidence text: ${snippet}`);
  }
};

assertIncludes('README.md', '.agent/verification-evidence.json');
assertIncludes('README.md', 'Fresh scaffolds create an idle placeholder');
assertIncludes('README.md', 'bash scripts/canonical-evidence-artifact-test.sh');
assertIncludes('.agent/README.md', '.agent/verification-evidence.json');
assertIncludes('.agent/README.md', 'durable canonical record of deterministic verification');
assertSectionIncludes('skills/completion-protocol/SKILL.md', '## Canonical Files', '- `.agent/verification-evidence.json`');
assertSectionIncludes('skills/completion-protocol/SKILL.md', '## Canonical Inputs', '- `.agent/verification-evidence.json`');
assertSectionIncludes('skills/completion-protocol/SKILL.md', '## Compaction And Recovery', '- `.agent/verification-evidence.json`');
assertSectionIncludes('skills/completion-protocol/SKILL.md', '## Compaction And Recovery', '`completion-implementer` must also re-read canonical `.agent/state.json`, `.agent/plan.json`, `.agent/active-slice.json`, and `.agent/verification-evidence.json` before resuming work.');
assertSectionIncludes('skills/completion-protocol/references/completion.md', '## Ignored Canonical Execution State', '- `.agent/verification-evidence.json`');
assertSectionIncludes('skills/completion-protocol/references/completion.md', '## Canonical Inputs', '- `.agent/verification-evidence.json`');
assertSectionIncludes('skills/completion-protocol/references/completion.md', '## Compaction And Recovery', '- `.agent/verification-evidence.json`');
assertSectionIncludes('skills/completion-protocol/references/completion.md', '## Compaction And Recovery', '`completion-implementer` must also re-read canonical `.agent/state.json`, `.agent/plan.json`, `.agent/active-slice.json`, and `.agent/verification-evidence.json` before resuming work.');
assertIncludes('extensions/completion/index.ts', 'Verification evidence artifact: ${evidence.path}');
assertIncludes('extensions/completion/index.ts', 'Verification evidence summary: ${evidence.summary}');
assertIncludes('extensions/completion/index.ts', 'Canonical verification evidence artifact is currently: ${evidence.path} (${evidence.status})');
assertIncludes('extensions/completion/prompt-surfaces.ts', '`- verification_evidence_path: ${evidence.path}`');
assertIncludes('extensions/completion/prompt-surfaces.ts', '`- verification_evidence_summary: ${evidence.summary}`');
assertIncludes('extensions/completion/index.ts', 'Consume .agent/verification-evidence.json instead of temp-only verification summaries when it is populated.');
assertIncludes('scripts/release-check.sh', 'bash .agent/verify_completion_control_plane.sh');
assertIncludes('scripts/release-check.sh', 'bash ./scripts/canonical-evidence-artifact-test.sh');
assertIncludes('.agent/verify_completion_control_plane.sh', '.agent/verification-evidence.json');
assertIncludes('.agent/verify_completion_control_plane.sh', 'subject_type must be selected_slice when active slice exact handoff requires verification evidence');
assertIncludes('.agent/verify_completion_stop.sh', '.agent/verification-evidence.json parity');
NODE

bash .agent/verify_completion_control_plane.sh >/dev/null

CURRENT_EVIDENCE_BACKUP="$TMPDIR/current-verification-evidence.json"
cp .agent/verification-evidence.json "$CURRENT_EVIDENCE_BACKUP"

python3 - <<'PY'
import json
from pathlib import Path
path = Path('.agent/verification-evidence.json')
evidence = json.loads(path.read_text())
evidence['head_sha'] = 'stale-head'
path.write_text(json.dumps(evidence, indent=2) + '\n')
PY

if bash ./scripts/release-check.sh >/dev/null 2>&1; then
  echo "expected release-check to fail when current repo verification-evidence.json is stale" >&2
  exit 1
fi

if bash .agent/verify_completion_stop.sh >/dev/null 2>&1; then
  echo "expected verify_completion_stop.sh to fail when current repo verification-evidence.json is stale" >&2
  exit 1
fi

cp "$CURRENT_EVIDENCE_BACKUP" .agent/verification-evidence.json
bash .agent/verify_completion_control_plane.sh >/dev/null

ROOT="$TMPDIR/repo"
SYSTEM_REMINDER="$TMPDIR/system-reminder.txt"
BOOTSTRAP_SESSION="$TMPDIR/session-canonical-evidence-bootstrap.jsonl"
BOOTSTRAP_DISCUSSION=$'Mission: Exercise canonical evidence fixture bootstrap.\nScope:\n- Materialize canonical completion files for the evidence artifact fixture.\nConstraints:\n- Use supported bare /cook startup only.\nAcceptance:\n- Scaffold canonical files before the fixture rewrites them.'
mkdir -p "$ROOT"
cd "$ROOT"
git init -q
write_session "$BOOTSTRAP_SESSION" "$ROOT" "$BOOTSTRAP_DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
pi --session "$BOOTSTRAP_SESSION" -e "$PKG_ROOT" -p "/cook" \
  >"$TMPDIR/pi-canonical-evidence-bootstrap.out" 2>"$TMPDIR/pi-canonical-evidence-bootstrap.err"

for file in .agent/profile.json .agent/state.json .agent/plan.json .agent/active-slice.json .agent/verification-evidence.json; do
  [[ -f "$file" ]] || { echo "missing canonical bootstrap file: $file" >&2; exit 1; }
done

bash .agent/verify_completion_control_plane.sh >/dev/null
bash .agent/verify_completion_stop.sh >/dev/null

python3 - <<'PY'
import json
from pathlib import Path

evidence = json.loads(Path('.agent/verification-evidence.json').read_text())
assert evidence['artifact_type'] == 'completion-verification-evidence', evidence
assert evidence['subject_type'] == 'none', evidence
assert evidence['verification_commands'] == [], evidence
assert evidence['outcome'] == 'not_recorded', evidence
assert evidence['recorded_at'] is None, evidence
assert evidence['head_sha'] is None, evidence
PY

git add .
git -c user.name='Test' -c user.email='test@example.com' commit -qm 'bootstrap fixture'
HEAD_SHA="$(git rev-parse HEAD)"

python3 - "$HEAD_SHA" <<'PY'
import json
import sys
from pathlib import Path

head_sha = sys.argv[1]
mission = 'Exercise canonical verification evidence parity.'
task_type = 'completion-workflow'
evaluation_profile = 'completion-rubric-v1'
verification_commands = [
    'bash .agent/verify_completion_control_plane.sh',
    'bash .agent/verify_completion_stop.sh',
]
implementation_surfaces = [
    '.agent/verification-evidence.json',
    '.agent/verify_completion_control_plane.sh',
    '.agent/verify_completion_stop.sh',
]
acceptance = [
    'Canonical verification evidence is recorded for the selected slice.',
    'Fail-closed verification rejects missing or stale evidence.',
]
state = {
    'schema_version': 1,
    'mission_anchor': mission,
    'current_phase': 'implement',
    'continuation_policy': 'continue',
    'continuation_reason': 'Fixture for canonical evidence artifact regression coverage.',
    'project_done': False,
    'task_type': task_type,
    'evaluation_profile': evaluation_profile,
    'requires_reground': False,
    'slices_since_last_reground': 0,
    'remaining_release_blockers': 0,
    'remaining_high_value_gaps': 1,
    'unsatisfied_contract_ids': ['CANONICAL-EVIDENCE-ARTIFACTS'],
    'release_blocker_ids': [],
    'next_mandatory_action': 'Implement selected slice evidence-fixture.',
    'next_mandatory_role': 'completion-implementer',
    'remaining_stop_judges': 3,
    'last_reground_at': '2026-05-03T00:00:00Z',
    'last_auditor_verdict': None,
    'contract_status': 'selected_slice_pending_implementation',
    'latest_completed_slice': head_sha,
    'latest_verified_slice': head_sha,
}
plan = {
    'schema_version': 1,
    'mission_anchor': mission,
    'task_type': task_type,
    'evaluation_profile': evaluation_profile,
    'last_reground_at': '2026-05-03T00:00:00Z',
    'plan_basis': 'canonical_evidence_fixture',
    'candidate_slices': [
        {
            'slice_id': 'evidence-fixture',
            'goal': 'Persist canonical verification evidence for the selected slice.',
            'acceptance_criteria': acceptance,
            'contract_ids': ['CANONICAL-EVIDENCE-ARTIFACTS'],
            'priority': 70,
            'status': 'selected',
            'why_now': 'Exercise fail-closed evidence parity.',
            'blocked_on': [],
            'evidence': [],
            'locked_notes': ['Keep the fixture scoped to canonical verification evidence parity.'],
            'must_fix_findings': [],
            'implementation_surfaces': implementation_surfaces,
            'verification_commands': verification_commands,
            'basis_commit': head_sha,
            'remaining_contract_ids_before': ['CANONICAL-EVIDENCE-ARTIFACTS'],
            'release_blocker_count_before': 0,
            'high_value_gap_count_before': 1,
        }
    ],
}
active = {
    'schema_version': 1,
    'mission_anchor': mission,
    'task_type': task_type,
    'evaluation_profile': evaluation_profile,
    'status': 'selected',
    'slice_id': 'evidence-fixture',
    'goal': 'Persist canonical verification evidence for the selected slice.',
    'contract_ids': ['CANONICAL-EVIDENCE-ARTIFACTS'],
    'acceptance_criteria': acceptance,
    'blocked_on': [],
    'locked_notes': ['Keep the fixture scoped to canonical verification evidence parity.'],
    'must_fix_findings': [],
    'implementation_surfaces': implementation_surfaces,
    'verification_commands': verification_commands,
    'basis_commit': head_sha,
    'remaining_contract_ids_before': ['CANONICAL-EVIDENCE-ARTIFACTS'],
    'release_blocker_count_before': 0,
    'high_value_gap_count_before': 1,
    'priority': 70,
    'why_now': 'Exercise fail-closed evidence parity.',
}

Path('.agent/state.json').write_text(json.dumps(state, indent=2) + '\n')
Path('.agent/plan.json').write_text(json.dumps(plan, indent=2) + '\n')
Path('.agent/active-slice.json').write_text(json.dumps(active, indent=2) + '\n')
PY

if bash .agent/verify_completion_control_plane.sh >/dev/null 2>&1; then
  echo "expected control-plane verification to fail while selected-slice evidence remains at idle placeholder state" >&2
  exit 1
fi

rm .agent/verification-evidence.json
if bash .agent/verify_completion_control_plane.sh >/dev/null 2>&1; then
  echo "expected control-plane verification to fail when verification-evidence.json is missing" >&2
  exit 1
fi

python3 - "$HEAD_SHA" <<'PY'
import json
import sys
from pathlib import Path

head_sha = sys.argv[1]
verification_commands = [
    'bash .agent/verify_completion_control_plane.sh',
    'bash .agent/verify_completion_stop.sh',
]
invalid = {
    'schema_version': 1,
    'artifact_type': 'completion-verification-evidence',
    'subject_type': 'selected_slice',
    'slice_id': 'evidence-fixture',
    'goal': 'Persist canonical verification evidence for the selected slice.',
    'contract_ids': ['CANONICAL-EVIDENCE-ARTIFACTS'],
    'basis_commit': head_sha,
    'head_sha': 'stale-head',
    'verification_commands': verification_commands,
    'outcome': 'passed',
    'recorded_at': '2026-05-03T00:00:00Z',
    'summary': 'Stale selected-slice evidence.',
}
Path('.agent/verification-evidence.json').write_text(json.dumps(invalid, indent=2) + '\n')
PY

HEAD_OUTPUT="$(bash .agent/verify_completion_control_plane.sh 2>&1 || true)"
[[ "$HEAD_OUTPUT" == *"head_sha"* ]] || { echo "expected stale-head verification failure to mention head_sha, got: $HEAD_OUTPUT" >&2; exit 1; }

python3 - "$HEAD_SHA" <<'PY'
import json
import sys
from pathlib import Path

head_sha = sys.argv[1]
invalid = {
    'schema_version': 1,
    'artifact_type': 'completion-verification-evidence',
    'subject_type': 'selected_slice',
    'slice_id': 'evidence-fixture',
    'goal': 'Persist canonical verification evidence for the selected slice.',
    'contract_ids': ['CANONICAL-EVIDENCE-ARTIFACTS'],
    'basis_commit': head_sha,
    'head_sha': head_sha,
    'verification_commands': ['bash .agent/verify_completion_control_plane.sh'],
    'outcome': 'passed',
    'recorded_at': '2026-05-03T00:00:00Z',
    'summary': 'Out-of-parity command set.',
}
Path('.agent/verification-evidence.json').write_text(json.dumps(invalid, indent=2) + '\n')
PY

COMMAND_OUTPUT="$(bash .agent/verify_completion_control_plane.sh 2>&1 || true)"
[[ "$COMMAND_OUTPUT" == *"verification_commands"* ]] || {
  echo "expected verification-command parity failure to mention verification_commands, got: $COMMAND_OUTPUT" >&2
  exit 1
}

python3 - "$HEAD_SHA" <<'PY'
import json
import sys
from pathlib import Path

head_sha = sys.argv[1]
valid = {
    'schema_version': 1,
    'artifact_type': 'completion-verification-evidence',
    'subject_type': 'selected_slice',
    'slice_id': 'evidence-fixture',
    'goal': 'Persist canonical verification evidence for the selected slice.',
    'contract_ids': ['CANONICAL-EVIDENCE-ARTIFACTS'],
    'basis_commit': head_sha,
    'head_sha': head_sha,
    'verification_commands': [
        'bash .agent/verify_completion_control_plane.sh',
        'bash .agent/verify_completion_stop.sh',
    ],
    'outcome': 'passed',
    'recorded_at': '2026-05-03T00:00:00Z',
    'summary': 'Selected-slice verification evidence matches the active slice and current HEAD.',
}
Path('.agent/verification-evidence.json').write_text(json.dumps(valid, indent=2) + '\n')
PY

bash .agent/verify_completion_control_plane.sh >/dev/null
bash .agent/verify_completion_stop.sh >/dev/null

rm -f "$SYSTEM_REMINDER"
PI_COMPLETION_TEST_SYSTEM_REMINDER_PATH="$SYSTEM_REMINDER" \
pi -e "$PKG_ROOT" -p "Summarize the completion reminder briefly." \
  >"$TMPDIR/pi-canonical-evidence-reminder.out" 2>"$TMPDIR/pi-canonical-evidence-reminder.err"

python3 - "$SYSTEM_REMINDER" <<'PY'
import sys
from pathlib import Path

reminder = Path(sys.argv[1])
assert not reminder.exists(), 'ordinary non-/cook turn should not inject completion reminder solely from selected-slice canonical state'
PY

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
    'continuation_reason': 'Fixture is complete; ordinary primary-agent turns should stay outside completion until /cook runs again.',
    'project_done': True,
    'remaining_high_value_gaps': 0,
    'unsatisfied_contract_ids': [],
    'next_mandatory_action': None,
    'next_mandatory_role': None,
    'remaining_stop_judges': 0,
    'contract_status': 'done',
})
state_path.write_text(json.dumps(state, indent=2) + '\n')

plan = json.loads(plan_path.read_text())
for slice_data in plan.get('candidate_slices', []):
    if slice_data.get('slice_id') == 'evidence-fixture':
        slice_data['status'] = 'done'
plan_path.write_text(json.dumps(plan, indent=2) + '\n')

active = json.loads(active_path.read_text())
active['status'] = 'done'
active_path.write_text(json.dumps(active, indent=2) + '\n')
PY

rm -f "$SYSTEM_REMINDER"
PI_COMPLETION_TEST_SYSTEM_REMINDER_PATH="$SYSTEM_REMINDER" \
pi -e "$PKG_ROOT" -p "Summarize the latest release briefly." \
  >"$TMPDIR/pi-canonical-evidence-done-reminder.out" 2>"$TMPDIR/pi-canonical-evidence-done-reminder.err"

python3 - "$SYSTEM_REMINDER" <<'PY'
import sys
from pathlib import Path

reminder = Path(sys.argv[1])
assert not reminder.exists(), 'ordinary non-/cook turn should not inject closed-workflow boundary routing before /cook reactivation'
PY

echo "canonical evidence artifact test passed: $TMPDIR"
