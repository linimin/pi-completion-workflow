#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

ROOT="$TMPDIR/repo"
KICKOFF_PROMPT="$TMPDIR/kickoff-prompt.txt"
RESUME_PROMPT="$TMPDIR/resume-prompt.txt"

mkdir -p "$ROOT"
cd "$ROOT"
git init -q

PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$KICKOFF_PROMPT" \
pi -e "$PKG_ROOT" -p "/cook smoke-test mission" \
  >"$TMPDIR/pi-completion-smoke-bootstrap.out" 2>"$TMPDIR/pi-completion-smoke-bootstrap.err"

for file in .agent/profile.json .agent/state.json .agent/plan.json .agent/active-slice.json; do
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
kickoff = Path(sys.argv[1]).read_text()

assert profile['task_type'] == expected_task_type, 'profile.json task_type mismatch after bootstrap'
assert profile['evaluation_profile'] == expected_eval_profile, 'profile.json evaluation_profile mismatch after bootstrap'
assert state['task_type'] == expected_task_type, 'state.json task_type mismatch after bootstrap'
assert state['evaluation_profile'] == expected_eval_profile, 'state.json evaluation_profile mismatch after bootstrap'
assert plan['task_type'] == expected_task_type, 'plan.json task_type mismatch after bootstrap'
assert plan['evaluation_profile'] == expected_eval_profile, 'plan.json evaluation_profile mismatch after bootstrap'
assert active['task_type'] == expected_task_type, 'active-slice.json task_type mismatch after bootstrap'
assert active['evaluation_profile'] == expected_eval_profile, 'active-slice.json evaluation_profile mismatch after bootstrap'
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

bash .agent/verify_completion_control_plane.sh >/dev/null
bash .agent/verify_completion_stop.sh >/dev/null

echo "smoke test passed: $ROOT"
