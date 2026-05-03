#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

ROOT="$TMPDIR/repo"
KICKOFF_PROMPT="$TMPDIR/kickoff-prompt.txt"
RESUME_PROMPT="$TMPDIR/resume-prompt.txt"
AUTO_RESUME_PROMPT="$TMPDIR/auto-resume-prompt.txt"

mkdir -p "$ROOT"
cd "$ROOT"
git init -q

PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$KICKOFF_PROMPT" \
pi -e "$PKG_ROOT" -p "/cook smoke-test mission" \
  >"$TMPDIR/pi-completion-smoke-bootstrap.out" 2>"$TMPDIR/pi-completion-smoke-bootstrap.err"

for file in .agent/profile.json .agent/state.json .agent/plan.json .agent/active-slice.json .agent/verification-evidence.json; do
  [[ -f "$file" ]] || { echo "missing canonical bootstrap file: $file" >&2; exit 1; }
done

bash .agent/verify_completion_control_plane.sh >/dev/null
bash .agent/verify_completion_stop.sh >/dev/null

python3 - "$KICKOFF_PROMPT" <<'PY'
import json
import sys
from pathlib import Path

expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'

profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())
evidence = json.loads(Path('.agent/verification-evidence.json').read_text())
kickoff = Path(sys.argv[1]).read_text()

assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after bootstrap'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after bootstrap'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after bootstrap'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after bootstrap'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after bootstrap'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after bootstrap'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after bootstrap'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after bootstrap'
assert active['implementation_surfaces'] == [], 'active-slice.json should scaffold empty implementation_surfaces'
assert active['verification_commands'] == [], 'active-slice.json should scaffold empty verification_commands'
assert evidence['artifact_type'] == 'completion-verification-evidence', 'verification-evidence.json artifact_type mismatch after bootstrap'
assert evidence['subject_type'] == 'none', 'verification-evidence.json should scaffold idle subject_type'
assert evidence['verification_commands'] == [], 'verification-evidence.json should scaffold empty verification_commands'
assert evidence['outcome'] == 'not_recorded', 'verification-evidence.json should scaffold not_recorded outcome'
assert 'Canonical routing profile:' in kickoff, 'kickoff prompt should expose canonical routing profile'
assert f'- task_type: {expected_task_type}' in kickoff, 'kickoff prompt missing canonical task_type'
assert f'- evaluation_profile: {expected_eval_profile}' in kickoff, 'kickoff prompt missing canonical evaluation_profile'
PY

PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$RESUME_PROMPT" \
pi -e "$PKG_ROOT" -p "/cook" \
  >"$TMPDIR/pi-completion-smoke-resume.out" 2>"$TMPDIR/pi-completion-smoke-resume.err"

python3 - "$RESUME_PROMPT" <<'PY'
import sys
from pathlib import Path

expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
resume = Path(sys.argv[1]).read_text()

assert 'Canonical routing profile:' in resume, 'resume prompt should expose canonical routing profile'
assert f'- task_type: {expected_task_type}' in resume, 'resume prompt missing canonical task_type'
assert f'- evaluation_profile: {expected_eval_profile}' in resume, 'resume prompt missing canonical evaluation_profile'
PY

PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_AUTO_CONTINUE_ON_SESSION_START=1 \
PI_COMPLETION_TEST_AUTO_CONTINUE_PROMPT_PATH="$AUTO_RESUME_PROMPT" \
pi -e "$PKG_ROOT" -p "/cook" \
  >"$TMPDIR/pi-completion-smoke-auto-resume.out" 2>"$TMPDIR/pi-completion-smoke-auto-resume.err"

python3 - "$AUTO_RESUME_PROMPT" <<'PY'
import sys
from pathlib import Path

expected_task_type = 'completion-workflow'
expected_eval_profile = 'completion-rubric-v1'
auto_resume = Path(sys.argv[1]).read_text()

assert 'Resume the completion workflow from canonical state.' in auto_resume, 'auto-resume prompt should use the canonical resume workflow prompt'
assert 'Canonical routing profile:' in auto_resume, 'auto-resume prompt should expose canonical routing profile'
assert f'- task_type: {expected_task_type}' in auto_resume, 'auto-resume prompt missing canonical task_type'
assert f'- evaluation_profile: {expected_eval_profile}' in auto_resume, 'auto-resume prompt missing canonical evaluation_profile'
PY

python3 - <<'PY'
import json
from pathlib import Path
path = Path('.agent/state.json')
state = json.loads(path.read_text())
state.pop('task_type', None)
path.write_text(json.dumps(state, indent=2) + '\n')
PY

if bash .agent/verify_completion_control_plane.sh >/dev/null 2>&1; then
  echo "expected control-plane verification to fail when state.json omits task_type" >&2
  exit 1
fi

python3 - <<'PY'
import json
from pathlib import Path
profile = json.loads(Path('.agent/profile.json').read_text())
state_path = Path('.agent/state.json')
state = json.loads(state_path.read_text())
state['task_type'] = profile['task_type']
state_path.write_text(json.dumps(state, indent=2) + '\n')
PY

python3 - <<'PY'
import json
from pathlib import Path
path = Path('.agent/active-slice.json')
active = json.loads(path.read_text())
active.pop('evaluation_profile', None)
path.write_text(json.dumps(active, indent=2) + '\n')
PY

if bash .agent/verify_completion_control_plane.sh >/dev/null 2>&1; then
  echo "expected control-plane verification to fail when active-slice.json omits evaluation_profile" >&2
  exit 1
fi

python3 - <<'PY'
import json
from pathlib import Path
profile = json.loads(Path('.agent/profile.json').read_text())
active_path = Path('.agent/active-slice.json')
active = json.loads(active_path.read_text())
active['evaluation_profile'] = profile['evaluation_profile']
active_path.write_text(json.dumps(active, indent=2) + '\n')
PY

python3 - <<'PY'
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
    'locked_notes': ['keep the change scoped to the selected active-slice contract'],
    'must_fix_findings': [],
    'implementation_surfaces': ['extensions/completion/index.ts', '.agent/verify_completion_control_plane.sh'],
    'verification_commands': ['bash .agent/verify_completion_control_plane.sh', 'npm run smoke-test'],
    'basis_commit': 'deadbeef',
    'remaining_contract_ids_before': ['smoke-contract'],
    'release_blocker_count_before': 1,
    'high_value_gap_count_before': 0,
})
active.pop('priority', None)
active.pop('why_now', None)
path.write_text(json.dumps(active, indent=2) + '\n')
PY

python3 - <<'PY'
import json
from pathlib import Path
active = json.loads(Path('.agent/active-slice.json').read_text())
plan_path = Path('.agent/plan.json')
plan = json.loads(plan_path.read_text())
plan['candidate_slices'] = [{
    'slice_id': active['slice_id'],
    'goal': active['goal'],
    'acceptance_criteria': active['acceptance_criteria'],
    'contract_ids': active['contract_ids'],
    'priority': 1,
    'status': 'selected',
    'why_now': 'smoke test exact handoff',
    'blocked_on': active['blocked_on'],
    'evidence': [],
    'locked_notes': active['locked_notes'],
    'must_fix_findings': active['must_fix_findings'],
    'implementation_surfaces': ['extensions/completion/index.ts', '.agent/verify_completion_control_plane.sh'],
    'verification_commands': ['bash .agent/verify_completion_control_plane.sh', 'npm run smoke-test'],
    'basis_commit': active['basis_commit'],
    'remaining_contract_ids_before': active['remaining_contract_ids_before'],
    'release_blocker_count_before': active['release_blocker_count_before'],
    'high_value_gap_count_before': active['high_value_gap_count_before'],
}]
plan_path.write_text(json.dumps(plan, indent=2) + '\n')
PY

python3 - <<'PY'
import json
from pathlib import Path

active = json.loads(Path('.agent/active-slice.json').read_text())
evidence = {
    'schema_version': 1,
    'artifact_type': 'completion-verification-evidence',
    'subject_type': 'selected_slice',
    'slice_id': active['slice_id'],
    'goal': active['goal'],
    'contract_ids': active['contract_ids'],
    'basis_commit': active['basis_commit'],
    'head_sha': active['basis_commit'],
    'verification_commands': ['bash .agent/verify_completion_control_plane.sh', 'npm run smoke-test'],
    'outcome': 'passed',
    'recorded_at': '2026-05-03T00:00:00Z',
    'summary': 'Smoke selected-slice evidence matches the temporary active-slice fixture.',
}
Path('.agent/verification-evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
PY

if bash .agent/verify_completion_control_plane.sh >/dev/null 2>&1; then
  echo "expected control-plane verification to fail when selected active-slice omits priority/why_now" >&2
  exit 1
fi

python3 - <<'PY'
import json
from pathlib import Path
path = Path('.agent/active-slice.json')
active = json.loads(path.read_text())
active['priority'] = 1
active['why_now'] = 'smoke test exact handoff'
path.write_text(json.dumps(active, indent=2) + '\n')
PY

python3 - <<'PY'
import json
from pathlib import Path
path = Path('.agent/active-slice.json')
active = json.loads(path.read_text())
active.pop('implementation_surfaces', None)
active.pop('verification_commands', None)
path.write_text(json.dumps(active, indent=2) + '\n')
PY

if bash .agent/verify_completion_control_plane.sh >/dev/null 2>&1; then
  echo "expected control-plane verification to fail when selected active-slice omits implementation_surfaces/verification_commands" >&2
  exit 1
fi

python3 - <<'PY'
import json
from pathlib import Path
path = Path('.agent/active-slice.json')
active = json.loads(path.read_text())
active['implementation_surfaces'] = ['extensions/completion/index.ts', '.agent/verify_completion_control_plane.sh']
active['verification_commands'] = ['bash .agent/verify_completion_control_plane.sh', 'npm run smoke-test']
path.write_text(json.dumps(active, indent=2) + '\n')
PY

bash .agent/verify_completion_control_plane.sh >/dev/null
bash .agent/verify_completion_stop.sh >/dev/null

python3 - "$PKG_ROOT" <<'PY'
import sys
from pathlib import Path

text = Path(sys.argv[1], 'extensions/completion', 'index.ts').read_text()
assert 'Active slice priority: ${activePriority}' in text, 'system reminder source should expose active-slice priority'
assert 'Active slice why_now: ${activeWhyNow}' in text, 'system reminder source should expose active-slice why_now'
assert 'Active implementation surfaces: ${implementationSurfaces.join(", ")}' in text, 'system reminder source should expose implementation_surfaces'
assert 'Active verification commands: ${verificationCommands.join(" | ")}' in text, 'system reminder source should expose verification_commands'
assert '`- implementation_surfaces: ${implementationSurfaces.join(" | ")}`' in text, 'resume capsule source should expose implementation_surfaces'
assert '`- verification_commands: ${verificationCommands.join(" | ")}`' in text, 'resume capsule source should expose verification_commands'
PY

echo "smoke test passed: $ROOT"
