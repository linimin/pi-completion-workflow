#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pi() {
  env -u PI_COMPLETION_ROLE command pi --no-extensions "$@"
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

write_mixed_session() {
  local session_path="$1"
  local cwd="$2"
  local assistant_text="$3"
  local user_text="$4"
  python3 - "$session_path" "$cwd" "$assistant_text" "$user_text" <<'PY'
import json
import sys
from pathlib import Path

session_path = Path(sys.argv[1])
cwd = sys.argv[2]
assistant_text = sys.argv[3]
user_text = sys.argv[4]
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
            "role": "assistant",
            "content": assistant_text,
            "timestamp": 1767225601000,
        },
    },
    {
        "type": "message",
        "id": "b2c3d4e5",
        "parentId": "a1b2c3d4",
        "timestamp": "2026-01-01T00:00:02.000Z",
        "message": {
            "role": "user",
            "content": user_text,
            "timestamp": 1767225602000,
        },
    },
]
with session_path.open('w', encoding='utf-8') as fh:
    for entry in entries:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
PY
}

write_completion_state() {
  local root="$1"
  local mission="$2"
  local continuation_policy="$3"
  local project_done="$4"
  local current_phase="$5"
  local next_role="$6"
  local next_action="$7"
  python3 - "$root" "$mission" "$continuation_policy" "$project_done" "$current_phase" "$next_role" "$next_action" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
mission = sys.argv[2]
continuation_policy = sys.argv[3]
project_done = sys.argv[4].lower() == 'true'
current_phase = sys.argv[5]
next_role = None if sys.argv[6] == 'null' else sys.argv[6]
next_action = None if sys.argv[7] == 'null' else sys.argv[7]
agent = root / '.agent'
agent.mkdir(parents=True, exist_ok=True)
(agent / 'mission.md').write_text(
    '# Mission\n\n'
    f'Project: {root.name}\n\n'
    'Mission anchor:\n'
    f'{mission}\n\n'
    "This file is a tracked human-readable statement of the repo's completion mission. Re-grounders may refine this file when repo truth becomes clearer, but it must stay truthful to shipped behavior and the active completion objective.\n",
    encoding='utf-8',
)
profile = {
    'schema_version': 1,
    'protocol_id': 'completion',
    'project_name': root.name,
    'required_stop_judges': 3,
    'priority_policy_id': 'completion-default',
    'task_type': 'completion-workflow',
    'evaluation_profile': 'completion-rubric-v1',
    'docs_surfaces': ['README.md', 'CHANGELOG.md'],
}
state = {
    'schema_version': 1,
    'mission_anchor': mission,
    'current_phase': current_phase,
    'continuation_policy': continuation_policy,
    'continuation_reason': 'test fixture',
    'project_done': project_done,
    'task_type': 'completion-workflow',
    'evaluation_profile': 'completion-rubric-v1',
    'requires_reground': continuation_policy == 'done',
    'slices_since_last_reground': 0,
    'remaining_release_blockers': 0,
    'remaining_high_value_gaps': 0,
    'unsatisfied_contract_ids': [],
    'release_blocker_ids': [],
    'next_mandatory_action': next_action,
    'next_mandatory_role': next_role,
    'remaining_stop_judges': 3,
    'last_reground_at': '2026-01-01T00:00:00Z',
    'last_auditor_verdict': None,
    'contract_status': 'partial' if continuation_policy != 'done' else 'done',
    'latest_completed_slice': None,
    'latest_verified_slice': None,
}
plan = {
    'schema_version': 1,
    'mission_anchor': mission,
    'task_type': 'completion-workflow',
    'evaluation_profile': 'completion-rubric-v1',
    'last_reground_at': '2026-01-01T00:00:00Z',
    'plan_basis': 'test-fixture',
    'candidate_slices': [],
}
active = {
    'schema_version': 1,
    'mission_anchor': mission,
    'task_type': 'completion-workflow',
    'evaluation_profile': 'completion-rubric-v1',
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
    'implementation_surfaces': [],
    'verification_commands': [],
    'basis_commit': None,
    'remaining_contract_ids_before': [],
    'release_blocker_count_before': None,
    'high_value_gap_count_before': None,
}
verification = {
    'schema_version': 1,
    'artifact_type': 'completion-verification-evidence',
    'subject_type': 'fixture',
    'slice_id': None,
    'goal': None,
    'contract_ids': [],
    'basis_commit': None,
    'head_sha': None,
    'verification_commands': [],
    'outcome': 'not_recorded',
    'recorded_at': None,
    'summary': 'test fixture',
}
(agent / 'profile.json').write_text(json.dumps(profile, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(agent / 'state.json').write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(agent / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(agent / 'active-slice.json').write_text(json.dumps(active, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
(agent / 'verification-evidence.json').write_text(json.dumps(verification, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY
}

write_fallback_extension() {
  local target="$1"
  cat >"$target" <<'TS'
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		const targetPath = process.env.PI_COOK_TRIGGER_FALLBACK_PATH;
		const allowedSource = process.env.PI_COOK_TRIGGER_FALLBACK_SOURCE ?? "interactive";
		if (!targetPath) return { action: "continue" };
		if (allowedSource !== "any" && event.source !== allowedSource) return { action: "continue" };
		await fsp.mkdir(path.dirname(targetPath), { recursive: true });
		await fsp.writeFile(
			targetPath,
			`${JSON.stringify({ text: event.text, source: event.source ?? null }, null, 2)}\n`,
			"utf8",
		);
		return { action: "handled" };
	});
}
TS
}

write_extension_sender_extension() {
  local target="$1"
  cat >"$target" <<'TS'
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let sent = false;
	pi.on("input", async (event) => {
		if (sent || event.source !== "interactive" || event.text !== "__seed__") return { action: "continue" };
		sent = true;
		const text = process.env.PI_COOK_TRIGGER_EXTENSION_SOURCE_TEXT?.trim();
		if (text) pi.sendUserMessage(text);
		return { action: "handled" };
	});
}
TS
}

FALLBACK_EXTENSION="$TMPDIR/fallback-handler.ts"
SENDER_EXTENSION="$TMPDIR/extension-sender.ts"
write_fallback_extension "$FALLBACK_EXTENSION"
write_extension_sender_extension "$SENDER_EXTENSION"

STARTUP_DISCUSSION=$'Mission: Route natural-language handoff into the shared /cook entry.\nScope:\n- Add an input hook before the primary agent starts implementation work.\n- Keep /cook as the canonical workflow boundary.\nConstraints:\n- Do not transform natural-language input into /cook.\nAcceptance:\n- Route execution handoff text into the shared /cook entry behind approval-only confirmation.'
STARTUP_MISSION='Route natural-language handoff into the shared /cook entry.'
ACTIVE_MISSION='Keep the startup-only natural-language /cook handoff working.'
REFOCUS_DISCUSSION=$'Mission: Expand commandless routing to bias-aware resume and refocus offers.\nScope:\n- Distinguish startup, resume, refocus, and next-round workflow offers before the primary agent runs.\n- Keep confirmed handoffs on the shared /cook entry.\nConstraints:\n- Do not duplicate /cook workflow logic.\nAcceptance:\n- Resume and refocus handoffs reach the shared /cook entry with bias metadata.'
REFOCUS_MISSION='Expand commandless routing to bias-aware resume and refocus offers.'
NEXT_ROUND_DISCUSSION=$'Mission: Start the next completion workflow round for docs parity cleanup.\nScope:\n- Refresh docs and tests around commandless workflow entry.\n- Keep the existing workflow history done.\nConstraints:\n- Do not reopen the finished workflow mission.\nAcceptance:\n- The next workflow round uses a new mission anchor without reopening the finished one.'
NEXT_ROUND_MISSION='Start the next completion workflow round for docs parity cleanup.'

STARTUP_CLASSIFIER_OUTPUT='{"decision":"offer_workflow","confidence":0.95,"workflow_bias":"startup","reason":"The latest input is a startup handoff from recent discussion into the canonical workflow.","focusHint":"shared /cook entry handoff","evidence":["current input is a start-execution phrase","recent discussion already defines a concrete workflow mission"],"riskFlags":[]}'
RESUME_CLASSIFIER_OUTPUT='{"decision":"offer_workflow","confidence":0.94,"workflow_bias":"resume","reason":"The latest input is continuing the active workflow.","focusHint":"resume current workflow","evidence":["canonical state already exists","the latest input is a continue-style handoff"],"riskFlags":[]}'
REFOCUS_CLASSIFIER_OUTPUT='{"decision":"offer_workflow","confidence":0.91,"workflow_bias":"refocus","reason":"The latest input is starting a different workflow direction from recent discussion.","focusHint":"bias-aware resume and refocus offers","evidence":["recent discussion changes the mission","the latest input confirms starting the new direction"],"riskFlags":["active-workflow-refocus-risk"]}'
NEXT_ROUND_CLASSIFIER_OUTPUT='{"decision":"offer_workflow","confidence":0.92,"workflow_bias":"next_round","reason":"The previous workflow is done and the latest input starts a new implementation round.","focusHint":"next workflow round docs parity","evidence":["canonical workflow is already done","recent discussion defines a new task"],"riskFlags":[]}'
NORMAL_CLASSIFIER_OUTPUT='{"decision":"normal_prompt","confidence":0.82,"workflow_bias":"unknown","reason":"The latest input is still asking the main agent to explain instead of handing control to /cook.","evidence":["the user is still asking for explanation in the main chat"],"riskFlags":["possible-normal-agent-request"]}'
UNCLEAR_CLASSIFIER_OUTPUT='{"decision":"unclear","confidence":0.41,"workflow_bias":"unknown","reason":"The latest input looks workflow-related but the safer path is to clarify whether this should resume or refocus the workflow.","focusHint":"bias-aware resume and refocus offers","evidence":["the latest input is a short start-intent acknowledgement","recent discussion suggests a different workflow candidate"],"riskFlags":["ambiguous-approval","multiple_candidate_missions"]}'

# Startup accepted routing should enter the shared /cook flow with natural-language metadata.
ROUTE_ROOT="$TMPDIR/route-repo"
ROUTE_SESSION="$TMPDIR/route-session.jsonl"
ROUTE_PROMPT="$TMPDIR/route-driver-prompt.txt"
ROUTE_ROUTING="$TMPDIR/route-routing.json"
ROUTE_CLASSIFIER="$TMPDIR/route-classifier.json"
ROUTE_CONFIRMATION="$TMPDIR/route-confirmation.json"
ROUTE_FALLBACK="$TMPDIR/route-fallback.json"
mkdir -p "$ROUTE_ROOT"
cd "$ROUTE_ROOT"
git init -q
write_session "$ROUTE_SESSION" "$ROUTE_ROOT" "$STARTUP_DISCUSSION"

PI_COOK_TRIGGER_FALLBACK_PATH="$ROUTE_FALLBACK" \
PI_COOK_TRIGGER_FALLBACK_SOURCE=interactive \
PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$ROUTE_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$STARTUP_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$ROUTE_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=start \
PI_COMPLETION_TEST_TRIGGER_CONFIRMATION_PATH="$ROUTE_CONFIRMATION" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$ROUTE_ROUTING" \
pi --session "$ROUTE_SESSION" -e "$PKG_ROOT" -e "$FALLBACK_EXTENSION" -p "開始做" \
  >"$TMPDIR/pi-cook-trigger-route.out" 2>"$TMPDIR/pi-cook-trigger-route.err"

python3 - "$ROUTE_PROMPT" "$ROUTE_ROUTING" "$ROUTE_CLASSIFIER" "$ROUTE_CONFIRMATION" "$ROUTE_FALLBACK" "$STARTUP_MISSION" "$TMPDIR/pi-cook-trigger-route.out" "$TMPDIR/pi-cook-trigger-route.err" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())
classifier = json.loads(Path(sys.argv[3]).read_text())
confirmation = json.loads(Path(sys.argv[4]).read_text())
fallback = Path(sys.argv[5])
mission = sys.argv[6]
output = Path(sys.argv[7]).read_text() + Path(sys.argv[8]).read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert routing['action'] == 'routed_to_cook', 'accepted startup handoff should route into the shared /cook entry'
assert routing['reason'] == 'accepted_takeover', 'accepted startup handoff should record the takeover reason'
assert routing['classificationDecision'] == 'offer_workflow', 'accepted startup handoff should snapshot the offer_workflow classifier result'
assert routing['workflowBias'] == 'startup', 'accepted startup handoff should preserve the startup routing bias'
assert routing['confirmationAction'] == 'start_workflow', 'accepted startup handoff should record the confirmed workflow action'
assert confirmation['title'] == 'Start a completion workflow from the recent discussion?', 'startup handoff should show the startup-specific workflow offer'
assert confirmation['actions'][0]['label'] == 'Start workflow', 'startup handoff should show the startup-specific primary action label'
assert classifier['result']['status'] == 'classified', 'accepted startup handoff should snapshot a classified trigger result'
assert classifier['result']['classification']['decision'] == 'offer_workflow', 'startup classifier snapshot should preserve offer_workflow'
assert classifier['result']['classification']['workflowBias'] == 'startup', 'startup classifier snapshot should preserve the startup bias'
assert not fallback.exists(), 'accepted startup handoff should keep the original interactive input away from later fallback handlers'
assert 'Start or continue the completion workflow for this repo.' in prompt, 'accepted startup handoff should queue the shared completion driver prompt'
assert 'Natural-language handoff metadata:' in prompt, 'accepted startup handoff should pass structured handoff metadata into the shared driver prompt'
assert '- preferred_routing_bias: startup' in prompt, 'accepted startup handoff should preserve the startup routing bias in the shared driver prompt'
assert '- trigger_text: 開始做' in prompt, 'accepted startup handoff should preserve the trigger text in the shared driver prompt'
assert state['mission_anchor'] == mission, 'accepted startup handoff should bootstrap canonical mission state through the shared /cook entry'
assert plan['mission_anchor'] == mission, 'accepted startup handoff should bootstrap plan.json through the shared /cook entry'
assert active['mission_anchor'] == mission, 'accepted startup handoff should bootstrap active-slice.json through the shared /cook entry'
assert profile['task_type'] == 'completion-workflow', 'accepted startup handoff should keep the canonical task_type'
assert 'Routing natural-language handoff into /cook.' in output, 'accepted startup handoff should notify that /cook took over'
PY

# Keep chatting should stay side-effect free and should not replay the original start-intent message.
KEEP_ROOT="$TMPDIR/keep-chatting-repo"
KEEP_SESSION="$TMPDIR/keep-chatting-session.jsonl"
KEEP_PROMPT="$TMPDIR/keep-chatting-driver-prompt.txt"
KEEP_ROUTING="$TMPDIR/keep-chatting-routing.json"
KEEP_CLASSIFIER="$TMPDIR/keep-chatting-classifier.json"
KEEP_CONFIRMATION="$TMPDIR/keep-chatting-confirmation.json"
KEEP_FALLBACK="$TMPDIR/keep-chatting-fallback.json"
mkdir -p "$KEEP_ROOT"
cd "$KEEP_ROOT"
git init -q
write_session "$KEEP_SESSION" "$KEEP_ROOT" "$STARTUP_DISCUSSION"

PI_COOK_TRIGGER_FALLBACK_PATH="$KEEP_FALLBACK" \
PI_COOK_TRIGGER_FALLBACK_SOURCE=interactive \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$KEEP_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$STARTUP_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$KEEP_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=keep_chatting \
PI_COMPLETION_TEST_TRIGGER_CONFIRMATION_PATH="$KEEP_CONFIRMATION" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$KEEP_ROUTING" \
pi --session "$KEEP_SESSION" -e "$PKG_ROOT" -e "$FALLBACK_EXTENSION" -p "開始做" \
  >"$TMPDIR/pi-cook-trigger-keep.out" 2>"$TMPDIR/pi-cook-trigger-keep.err"

python3 - "$KEEP_ROUTING" "$KEEP_CLASSIFIER" "$KEEP_CONFIRMATION" "$KEEP_FALLBACK" "$KEEP_PROMPT" "$TMPDIR/pi-cook-trigger-keep.out" "$TMPDIR/pi-cook-trigger-keep.err" <<'PY'
import json
import sys
from pathlib import Path

routing = json.loads(Path(sys.argv[1]).read_text())
classifier = json.loads(Path(sys.argv[2]).read_text())
confirmation = json.loads(Path(sys.argv[3]).read_text())
fallback = Path(sys.argv[4])
driver_prompt = Path(sys.argv[5])
output = Path(sys.argv[6]).read_text() + Path(sys.argv[7]).read_text()

assert routing['action'] == 'handled', 'keep chatting should keep the workflow offer side-effect free'
assert routing['reason'] == 'user_kept_chatting', 'keep chatting should record the user_kept_chatting routing reason'
assert routing['classificationDecision'] == 'offer_workflow', 'keep chatting should still snapshot the offer_workflow classifier result'
assert routing['workflowBias'] == 'startup', 'keep chatting should preserve the original workflow bias'
assert routing['confirmationAction'] == 'keep_chatting', 'keep chatting should record the keep_chatting confirmation action'
assert confirmation['actions'][1]['label'] == 'Keep chatting', 'keep chatting should expose the side-effect-free keep-chatting action'
assert classifier['result']['classification']['workflowBias'] == 'startup', 'keep chatting should preserve the startup bias in the classifier snapshot'
assert not fallback.exists(), 'keep chatting should not replay the original interactive start-intent message to later fallback handlers'
assert not driver_prompt.exists(), 'keep chatting should not queue a /cook driver prompt'
assert not Path('.agent').exists(), 'keep chatting should not bootstrap canonical workflow state'
assert 'side-effect free' in output, 'keep chatting should tell the user that the workflow offer stayed side-effect free'
PY

# Candidate natural-language prompts classified as normal prompts should continue to the main agent path.
NORMAL_ROOT="$TMPDIR/normal-repo"
NORMAL_SESSION="$TMPDIR/normal-session.jsonl"
NORMAL_ROUTING="$TMPDIR/normal-routing.json"
NORMAL_CLASSIFIER="$TMPDIR/normal-classifier.json"
NORMAL_FALLBACK="$TMPDIR/normal-fallback.json"
NORMAL_PROMPT="$TMPDIR/normal-driver-prompt.txt"
mkdir -p "$NORMAL_ROOT"
cd "$NORMAL_ROOT"
git init -q
write_session "$NORMAL_SESSION" "$NORMAL_ROOT" "$STARTUP_DISCUSSION"

PI_COOK_TRIGGER_FALLBACK_PATH="$NORMAL_FALLBACK" \
PI_COOK_TRIGGER_FALLBACK_SOURCE=interactive \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$NORMAL_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$NORMAL_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$NORMAL_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$NORMAL_ROUTING" \
pi --session "$NORMAL_SESSION" -e "$PKG_ROOT" -e "$FALLBACK_EXTENSION" -p "start by explaining the current repo state" \
  >"$TMPDIR/pi-cook-trigger-normal.out" 2>"$TMPDIR/pi-cook-trigger-normal.err"

python3 - "$NORMAL_ROUTING" "$NORMAL_CLASSIFIER" "$NORMAL_FALLBACK" "$NORMAL_PROMPT" <<'PY'
import json
import sys
from pathlib import Path

routing = json.loads(Path(sys.argv[1]).read_text())
classifier = json.loads(Path(sys.argv[2]).read_text())
fallback = json.loads(Path(sys.argv[3]).read_text())
driver_prompt = Path(sys.argv[4])

assert routing['action'] == 'continue', 'normal prompts should pass through to the main agent path'
assert routing['reason'] == 'classifier_normal_prompt', 'normal prompts should record the classifier_normal_prompt routing reason'
assert routing['classificationDecision'] == 'normal_prompt', 'normal prompts should snapshot the normal_prompt classifier decision'
assert routing['workflowBias'] == 'unknown', 'normal prompts should preserve the unknown workflow bias'
assert classifier['result']['status'] == 'classified', 'normal prompt pass-through should snapshot a classified trigger result'
assert classifier['result']['classification']['decision'] == 'normal_prompt', 'normal prompt pass-through should preserve the normal_prompt decision'
assert fallback['source'] == 'interactive', 'normal prompt pass-through should reach a later interactive fallback handler'
assert fallback['text'] == 'start by explaining the current repo state', 'normal prompt pass-through should preserve the original prompt text'
assert not Path('.agent').exists(), 'normal prompt pass-through should not bootstrap canonical workflow state'
assert not driver_prompt.exists(), 'normal prompt pass-through should not queue a /cook driver prompt'
PY

# Resume offers should keep the active workflow on the shared canonical resume path.
RESUME_ROOT="$TMPDIR/resume-repo"
RESUME_SESSION="$TMPDIR/resume-session.jsonl"
RESUME_PROMPT="$TMPDIR/resume-driver-prompt.txt"
RESUME_ROUTING="$TMPDIR/resume-routing.json"
RESUME_CLASSIFIER="$TMPDIR/resume-classifier.json"
RESUME_CONFIRMATION="$TMPDIR/resume-confirmation.json"
RESUME_FALLBACK="$TMPDIR/resume-fallback.json"
mkdir -p "$RESUME_ROOT"
cd "$RESUME_ROOT"
git init -q
write_completion_state "$RESUME_ROOT" "$ACTIVE_MISSION" continue false implement completion-implementer "Implement the active workflow slice"
write_session "$RESUME_SESSION" "$RESUME_ROOT" "$STARTUP_DISCUSSION"

PI_COOK_TRIGGER_FALLBACK_PATH="$RESUME_FALLBACK" \
PI_COOK_TRIGGER_FALLBACK_SOURCE=interactive \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$RESUME_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$RESUME_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$RESUME_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=start \
PI_COMPLETION_TEST_TRIGGER_CONFIRMATION_PATH="$RESUME_CONFIRMATION" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$RESUME_ROUTING" \
pi --session "$RESUME_SESSION" -e "$PKG_ROOT" -e "$FALLBACK_EXTENSION" -p "繼續做" \
  >"$TMPDIR/pi-cook-trigger-resume.out" 2>"$TMPDIR/pi-cook-trigger-resume.err"

python3 - "$RESUME_PROMPT" "$RESUME_ROUTING" "$RESUME_CLASSIFIER" "$RESUME_CONFIRMATION" "$RESUME_FALLBACK" "$ACTIVE_MISSION" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())
classifier = json.loads(Path(sys.argv[3]).read_text())
confirmation = json.loads(Path(sys.argv[4]).read_text())
fallback = Path(sys.argv[5])
mission = sys.argv[6]
state = json.loads(Path('.agent/state.json').read_text())

assert routing['action'] == 'routed_to_cook', 'resume handoff should route into the shared /cook entry'
assert routing['workflowBias'] == 'resume', 'resume handoff should preserve the resume routing bias'
assert routing['confirmationAction'] == 'start_workflow', 'resume handoff should record the workflow confirmation action'
assert confirmation['title'] == 'Resume the current completion workflow?', 'resume handoff should show the resume-specific workflow offer'
assert confirmation['actions'][0]['label'] == 'Resume workflow', 'resume handoff should show the resume-specific primary action label'
assert classifier['result']['classification']['workflowBias'] == 'resume', 'resume classifier snapshot should preserve the resume bias'
assert not fallback.exists(), 'resume handoff should keep the original interactive input away from later fallback handlers'
assert 'Resume the completion workflow from canonical state.' in prompt, 'resume handoff should queue the shared canonical resume prompt'
assert 'Natural-language handoff metadata:' in prompt, 'resume handoff should pass structured handoff metadata into the resume prompt'
assert '- preferred_routing_bias: resume' in prompt, 'resume handoff should preserve the resume bias in the resume prompt'
assert '- trigger_text: 繼續做' in prompt, 'resume handoff should preserve the trigger text in the resume prompt'
assert state['mission_anchor'] == mission, 'resume handoff should preserve the active mission anchor'
PY

# Refocus offers should keep the chooser semantics inside the shared /cook entry before rewriting canonical state.
REFOCUS_ROOT="$TMPDIR/refocus-repo"
REFOCUS_SESSION="$TMPDIR/refocus-session.jsonl"
REFOCUS_PROMPT="$TMPDIR/refocus-driver-prompt.txt"
REFOCUS_ROUTING="$TMPDIR/refocus-routing.json"
REFOCUS_CLASSIFIER="$TMPDIR/refocus-classifier.json"
REFOCUS_CONFIRMATION="$TMPDIR/refocus-confirmation.json"
REFOCUS_CHOOSER="$TMPDIR/refocus-chooser.json"
mkdir -p "$REFOCUS_ROOT"
cd "$REFOCUS_ROOT"
git init -q
write_completion_state "$REFOCUS_ROOT" "$ACTIVE_MISSION" continue false implement completion-implementer "Implement the active workflow slice"
write_session "$REFOCUS_SESSION" "$REFOCUS_ROOT" "$REFOCUS_DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$REFOCUS_PROMPT" \
PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH="$REFOCUS_CHOOSER" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$REFOCUS_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$REFOCUS_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=start \
PI_COMPLETION_TEST_TRIGGER_CONFIRMATION_PATH="$REFOCUS_CONFIRMATION" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$REFOCUS_ROUTING" \
pi --session "$REFOCUS_SESSION" -e "$PKG_ROOT" -p "好，開始做這個" \
  >"$TMPDIR/pi-cook-trigger-refocus.out" 2>"$TMPDIR/pi-cook-trigger-refocus.err"

python3 - "$REFOCUS_PROMPT" "$REFOCUS_ROUTING" "$REFOCUS_CLASSIFIER" "$REFOCUS_CONFIRMATION" "$REFOCUS_CHOOSER" "$REFOCUS_MISSION" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())
classifier = json.loads(Path(sys.argv[3]).read_text())
confirmation = json.loads(Path(sys.argv[4]).read_text())
chooser = json.loads(Path(sys.argv[5]).read_text())
mission = sys.argv[6]
state = json.loads(Path('.agent/state.json').read_text())

assert routing['action'] == 'routed_to_cook', 'refocus handoff should route into the shared /cook entry'
assert routing['workflowBias'] == 'refocus', 'refocus handoff should preserve the refocus routing bias'
assert confirmation['title'] == 'Refocus the completion workflow from the recent discussion?', 'refocus handoff should show the refocus-specific workflow offer'
assert confirmation['actions'][0]['label'] == 'Refocus workflow', 'refocus handoff should show the refocus-specific primary action label'
assert classifier['result']['classification']['workflowBias'] == 'refocus', 'refocus classifier snapshot should preserve the refocus bias'
assert chooser['candidateMissions'][0] == mission, 'refocus chooser snapshot should preserve the replacement mission'
assert 'Start or continue the completion workflow for this repo.' in prompt, 'refocus handoff should queue the shared completion driver prompt'
assert 'Natural-language handoff metadata:' in prompt, 'refocus handoff should pass structured handoff metadata into the shared driver prompt'
assert '- preferred_routing_bias: refocus' in prompt, 'refocus handoff should preserve the refocus bias in the shared driver prompt'
assert '- trigger_text: 好，開始做這個' in prompt, 'refocus handoff should preserve the trigger text in the shared driver prompt'
assert state['mission_anchor'] == mission, 'refocus handoff should rewrite canonical mission state only through the shared /cook entry'
PY

# Next-round offers should start a new workflow round from recent discussion after a completed workflow.
NEXT_ROOT="$TMPDIR/next-round-repo"
NEXT_SESSION="$TMPDIR/next-round-session.jsonl"
NEXT_PROMPT="$TMPDIR/next-round-driver-prompt.txt"
NEXT_ROUTING="$TMPDIR/next-round-routing.json"
NEXT_CLASSIFIER="$TMPDIR/next-round-classifier.json"
NEXT_CONFIRMATION="$TMPDIR/next-round-confirmation.json"
mkdir -p "$NEXT_ROOT"
cd "$NEXT_ROOT"
git init -q
write_completion_state "$NEXT_ROOT" "$ACTIVE_MISSION" done true done null null
write_session "$NEXT_SESSION" "$NEXT_ROOT" "$NEXT_ROUND_DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$NEXT_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$NEXT_ROUND_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$NEXT_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=start \
PI_COMPLETION_TEST_TRIGGER_CONFIRMATION_PATH="$NEXT_CONFIRMATION" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$NEXT_ROUTING" \
pi --session "$NEXT_SESSION" -e "$PKG_ROOT" -p "開始下一輪" \
  >"$TMPDIR/pi-cook-trigger-next-round.out" 2>"$TMPDIR/pi-cook-trigger-next-round.err"

python3 - "$NEXT_PROMPT" "$NEXT_ROUTING" "$NEXT_CLASSIFIER" "$NEXT_CONFIRMATION" "$NEXT_ROUND_MISSION" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())
classifier = json.loads(Path(sys.argv[3]).read_text())
confirmation = json.loads(Path(sys.argv[4]).read_text())
mission = sys.argv[5]
state = json.loads(Path('.agent/state.json').read_text())

assert routing['action'] == 'routed_to_cook', 'next-round handoff should route into the shared /cook entry'
assert routing['workflowBias'] == 'next_round', 'next-round handoff should preserve the next_round routing bias'
assert confirmation['title'] == 'Start the next completion workflow round from the recent discussion?', 'next-round handoff should show the next-round-specific workflow offer'
assert confirmation['actions'][0]['label'] == 'Start next round', 'next-round handoff should show the next-round-specific primary action label'
assert classifier['result']['classification']['workflowBias'] == 'next_round', 'next-round classifier snapshot should preserve the next_round bias'
assert 'Natural-language handoff metadata:' in prompt, 'next-round handoff should pass structured handoff metadata into the shared driver prompt'
assert '- preferred_routing_bias: next_round' in prompt, 'next-round handoff should preserve the next_round bias in the shared driver prompt'
assert '- trigger_text: 開始下一輪' in prompt, 'next-round handoff should preserve the trigger text in the shared driver prompt'
assert state['mission_anchor'] == mission, 'next-round handoff should start a new mission anchor through the shared /cook entry'
PY

# Unclear low-confidence commandless inputs should clarify instead of silently falling through.
UNCLEAR_ROOT="$TMPDIR/unclear-repo"
UNCLEAR_SESSION="$TMPDIR/unclear-session.jsonl"
UNCLEAR_PROMPT="$TMPDIR/unclear-driver-prompt.txt"
UNCLEAR_ROUTING="$TMPDIR/unclear-routing.json"
UNCLEAR_CLASSIFIER="$TMPDIR/unclear-classifier.json"
UNCLEAR_CLARIFICATION="$TMPDIR/unclear-clarification.json"
mkdir -p "$UNCLEAR_ROOT"
cd "$UNCLEAR_ROOT"
git init -q
write_completion_state "$UNCLEAR_ROOT" "$ACTIVE_MISSION" continue false implement completion-implementer "Implement the active workflow slice"
write_session "$UNCLEAR_SESSION" "$UNCLEAR_ROOT" "$REFOCUS_DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_EXISTING_WORKFLOW_ACTION=refocus \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$UNCLEAR_PROMPT" \
PI_COMPLETION_TEST_EXISTING_WORKFLOW_CHOOSER_PATH="$REFOCUS_CHOOSER" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$UNCLEAR_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$UNCLEAR_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_CLARIFICATION_ACTION=refocus \
PI_COMPLETION_TEST_TRIGGER_CLARIFICATION_PATH="$UNCLEAR_CLARIFICATION" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$UNCLEAR_ROUTING" \
pi --session "$UNCLEAR_SESSION" -e "$PKG_ROOT" -p "好，開始做這個" \
  >"$TMPDIR/pi-cook-trigger-unclear.out" 2>"$TMPDIR/pi-cook-trigger-unclear.err"

python3 - "$UNCLEAR_PROMPT" "$UNCLEAR_ROUTING" "$UNCLEAR_CLASSIFIER" "$UNCLEAR_CLARIFICATION" "$REFOCUS_MISSION" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())
classifier = json.loads(Path(sys.argv[3]).read_text())
clarification = json.loads(Path(sys.argv[4]).read_text())
mission = sys.argv[5]
state = json.loads(Path('.agent/state.json').read_text())

assert routing['action'] == 'routed_to_cook', 'unclear commandless routing should resolve through clarification instead of silently continuing'
assert routing['reason'] == 'clarification_resolved', 'unclear commandless routing should record clarification_resolved'
assert routing['classificationDecision'] == 'unclear', 'unclear routing should preserve the unclear classifier decision'
assert routing['clarificationAction'] == 'route_refocus', 'unclear routing should record the selected clarification action'
assert routing['clarificationSelectedBias'] == 'refocus', 'unclear routing should preserve the clarification-selected routing bias'
assert routing['clarificationGoal'] == mission, 'unclear routing should preserve the clarified mission goal'
assert classifier['result']['classification']['decision'] == 'unclear', 'unclear classifier snapshot should preserve the unclear decision'
assert clarification['title'] == 'Clarify how the completion workflow should proceed', 'unclear routing should show the clarification chooser'
assert clarification['actions'][0]['id'] == 'route_resume', 'unclear active workflow clarification should offer resume first'
assert clarification['actions'][1]['id'] == 'route_refocus', 'unclear active workflow clarification should offer refocus'
assert 'Natural-language handoff metadata:' in prompt, 'clarified commandless routing should still pass structured handoff metadata into the shared driver prompt'
assert '- clarification_selected_bias: refocus' in prompt, 'clarified commandless routing should carry clarification bias into the shared driver prompt'
assert f'- clarification_goal: {mission}' in prompt, 'clarified commandless routing should carry the clarified mission goal into the shared driver prompt'
assert state['mission_anchor'] == mission, 'clarified refocus routing should still rewrite canonical state only through the shared /cook entry'
PY

# Clarification cancel should fail closed without replaying the original message or rewriting canonical state.
UNCLEAR_CANCEL_ROOT="$TMPDIR/unclear-cancel-repo"
UNCLEAR_CANCEL_SESSION="$TMPDIR/unclear-cancel-session.jsonl"
UNCLEAR_CANCEL_PROMPT="$TMPDIR/unclear-cancel-driver-prompt.txt"
UNCLEAR_CANCEL_ROUTING="$TMPDIR/unclear-cancel-routing.json"
UNCLEAR_CANCEL_CLARIFICATION="$TMPDIR/unclear-cancel-clarification.json"
mkdir -p "$UNCLEAR_CANCEL_ROOT"
cd "$UNCLEAR_CANCEL_ROOT"
git init -q
write_completion_state "$UNCLEAR_CANCEL_ROOT" "$ACTIVE_MISSION" continue false implement completion-implementer "Implement the active workflow slice"
write_session "$UNCLEAR_CANCEL_SESSION" "$UNCLEAR_CANCEL_ROOT" "$REFOCUS_DISCUSSION"

PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$UNCLEAR_CANCEL_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$UNCLEAR_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CLARIFICATION_ACTION=cancel \
PI_COMPLETION_TEST_TRIGGER_CLARIFICATION_PATH="$UNCLEAR_CANCEL_CLARIFICATION" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$UNCLEAR_CANCEL_ROUTING" \
pi --session "$UNCLEAR_CANCEL_SESSION" -e "$PKG_ROOT" -p "好，開始做這個" \
  >"$TMPDIR/pi-cook-trigger-unclear-cancel.out" 2>"$TMPDIR/pi-cook-trigger-unclear-cancel.err"

python3 - "$UNCLEAR_CANCEL_ROUTING" "$UNCLEAR_CANCEL_PROMPT" "$TMPDIR/pi-cook-trigger-unclear-cancel.out" "$TMPDIR/pi-cook-trigger-unclear-cancel.err" "$ACTIVE_MISSION" <<'PY'
import json
import sys
from pathlib import Path

routing = json.loads(Path(sys.argv[1]).read_text())
driver_prompt = Path(sys.argv[2])
output = Path(sys.argv[3]).read_text() + Path(sys.argv[4]).read_text()
mission = sys.argv[5]
state = json.loads(Path('.agent/state.json').read_text())

assert routing['action'] == 'handled', 'clarification cancel should fail closed instead of continuing to the main agent'
assert routing['reason'] == 'user_cancelled_clarification', 'clarification cancel should record the user_cancelled_clarification reason'
assert routing['clarificationAction'] == 'cancel', 'clarification cancel should record the cancel action'
assert not driver_prompt.exists(), 'clarification cancel should not queue a /cook driver prompt'
assert 'rerun /cook explicitly' in output, 'clarification cancel should direct the user back to explicit /cook when needed'
assert state['mission_anchor'] == mission, 'clarification cancel should keep canonical state unchanged'
PY

# Explicit adoption of a recent assistant plan should carry adopted context into the shared /cook entry.
ADOPTED_PLAN_ROOT="$TMPDIR/adopted-plan-repo"
ADOPTED_PLAN_SESSION="$TMPDIR/adopted-plan-session.jsonl"
ADOPTED_PLAN_PROMPT="$TMPDIR/adopted-plan-driver-prompt.txt"
ADOPTED_PLAN_ROUTING="$TMPDIR/adopted-plan-routing.json"
mkdir -p "$ADOPTED_PLAN_ROOT"
cd "$ADOPTED_PLAN_ROOT"
git init -q
write_mixed_session "$ADOPTED_PLAN_SESSION" "$ADOPTED_PLAN_ROOT" "$STARTUP_DISCUSSION" "$STARTUP_DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$ADOPTED_PLAN_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$STARTUP_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=start \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$ADOPTED_PLAN_ROUTING" \
pi --session "$ADOPTED_PLAN_SESSION" -e "$PKG_ROOT" -p "就照剛剛那份方案做" \
  >"$TMPDIR/pi-cook-trigger-adopted-plan.out" 2>"$TMPDIR/pi-cook-trigger-adopted-plan.err"

python3 - "$ADOPTED_PLAN_PROMPT" "$ADOPTED_PLAN_ROUTING" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())

assert routing['adoptedArtifactKind'] == 'recent_plan', 'explicit adoption of the recent assistant plan should surface as a recent_plan artifact'
assert routing['adoptedArtifactBasis'] == 'explicit_user_adoption', 'adopted recent plans should preserve the explicit_user_adoption basis'
assert '- adopted_artifact_kind: recent_plan' in prompt, 'adopted recent plans should be forwarded into the shared /cook entry metadata'
assert '- adopted_artifact_basis: explicit_user_adoption' in prompt, 'adopted recent plans should preserve their trust-boundary basis in the shared driver prompt'
assert '- adopted_artifact_title: latest discussed assistant plan' in prompt, 'adopted recent plans should include the adopted artifact title in the shared driver prompt'
assert '- adopted_artifact_preview:' in prompt, 'adopted recent plans should include preview context in the shared driver prompt'
PY

# Explicit adoption of a repo markdown artifact should carry the path into the shared /cook entry.
ADOPTED_MD_ROOT="$TMPDIR/adopted-md-repo"
ADOPTED_MD_SESSION="$TMPDIR/adopted-md-session.jsonl"
ADOPTED_MD_PROMPT="$TMPDIR/adopted-md-driver-prompt.txt"
ADOPTED_MD_ROUTING="$TMPDIR/adopted-md-routing.json"
mkdir -p "$ADOPTED_MD_ROOT/docs"
cd "$ADOPTED_MD_ROOT"
git init -q
cat > docs/plan.md <<'EOF'
# Plan

Mission: Route natural-language handoff into the shared /cook entry.
EOF
write_session "$ADOPTED_MD_SESSION" "$ADOPTED_MD_ROOT" "$STARTUP_DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$ADOPTED_MD_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$STARTUP_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=start \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$ADOPTED_MD_ROUTING" \
pi --session "$ADOPTED_MD_SESSION" -e "$PKG_ROOT" -p "照 docs/plan.md 開始" \
  >"$TMPDIR/pi-cook-trigger-adopted-md.out" 2>"$TMPDIR/pi-cook-trigger-adopted-md.err"

python3 - "$ADOPTED_MD_PROMPT" "$ADOPTED_MD_ROUTING" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())

assert routing['adoptedArtifactKind'] == 'repo_markdown', 'explicit adoption of a repo markdown artifact should surface as repo_markdown'
assert routing['adoptedArtifactPath'] == 'docs/plan.md', 'repo markdown adoption should preserve the adopted path'
assert '- adopted_artifact_kind: repo_markdown' in prompt, 'repo markdown adoption should be forwarded into the shared /cook entry metadata'
assert '- adopted_artifact_path: docs/plan.md' in prompt, 'repo markdown adoption should preserve the adopted path in the shared driver prompt'
PY

# An unresolved explicit repo markdown path must fail closed instead of falling back to recent-plan metadata.
MISSING_MD_ROOT="$TMPDIR/missing-md-repo"
MISSING_MD_SESSION="$TMPDIR/missing-md-session.jsonl"
MISSING_MD_PROMPT="$TMPDIR/missing-md-driver-prompt.txt"
MISSING_MD_ROUTING="$TMPDIR/missing-md-routing.json"
mkdir -p "$MISSING_MD_ROOT"
cd "$MISSING_MD_ROOT"
git init -q
write_mixed_session "$MISSING_MD_SESSION" "$MISSING_MD_ROOT" "$STARTUP_DISCUSSION" "$STARTUP_DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$MISSING_MD_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$STARTUP_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=start \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$MISSING_MD_ROUTING" \
pi --session "$MISSING_MD_SESSION" -e "$PKG_ROOT" -p "use docs/missing.md" \
  >"$TMPDIR/pi-cook-trigger-missing-md.out" 2>"$TMPDIR/pi-cook-trigger-missing-md.err"

python3 - "$MISSING_MD_PROMPT" "$MISSING_MD_ROUTING" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())

assert routing['adoptedArtifactKind'] is None, 'unresolved explicit repo markdown paths must not fall back to recent_plan adoption metadata'
assert routing['adoptedArtifactBasis'] is None, 'unresolved explicit repo markdown paths must not preserve adopted-artifact trust metadata'
assert '- adopted_artifact_kind:' not in prompt, 'unresolved explicit repo markdown paths must not be elevated into the shared /cook handoff metadata'
assert '- adopted_artifact_basis:' not in prompt, 'unresolved explicit repo markdown paths must not preserve adopted-artifact basis metadata in the shared driver prompt'
PY

# Unadopted assistant plans should remain background only and should not be elevated into handoff context.
UNADOPTED_PLAN_ROOT="$TMPDIR/unadopted-plan-repo"
UNADOPTED_PLAN_SESSION="$TMPDIR/unadopted-plan-session.jsonl"
UNADOPTED_PLAN_PROMPT="$TMPDIR/unadopted-plan-driver-prompt.txt"
UNADOPTED_PLAN_ROUTING="$TMPDIR/unadopted-plan-routing.json"
mkdir -p "$UNADOPTED_PLAN_ROOT"
cd "$UNADOPTED_PLAN_ROOT"
git init -q
write_mixed_session "$UNADOPTED_PLAN_SESSION" "$UNADOPTED_PLAN_ROOT" "$STARTUP_DISCUSSION" "$STARTUP_DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$UNADOPTED_PLAN_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$STARTUP_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=start \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$UNADOPTED_PLAN_ROUTING" \
pi --session "$UNADOPTED_PLAN_SESSION" -e "$PKG_ROOT" -p "開始做" \
  >"$TMPDIR/pi-cook-trigger-unadopted-plan.out" 2>"$TMPDIR/pi-cook-trigger-unadopted-plan.err"

python3 - "$UNADOPTED_PLAN_PROMPT" "$UNADOPTED_PLAN_ROUTING" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())

assert routing['adoptedArtifactKind'] is None, 'unadopted assistant plans must stay background-only in routing snapshots'
assert '- adopted_artifact_kind:' not in prompt, 'unadopted assistant plans must not be elevated into the shared /cook handoff metadata'
PY

# Extension-originated turns should bypass natural-language routing and continue unchanged.
EXT_ROOT="$TMPDIR/extension-source-repo"
EXT_ROUTING="$TMPDIR/extension-source-routing.json"
EXT_FALLBACK="$TMPDIR/extension-source-fallback.json"
EXT_CLASSIFIER="$TMPDIR/extension-source-classifier.json"
EXT_PROMPT="$TMPDIR/extension-source-driver-prompt.txt"
mkdir -p "$EXT_ROOT"
cd "$EXT_ROOT"
git init -q

PI_COOK_TRIGGER_EXTENSION_SOURCE_TEXT="開始做" \
PI_COOK_TRIGGER_FALLBACK_PATH="$EXT_FALLBACK" \
PI_COOK_TRIGGER_FALLBACK_SOURCE=extension \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$EXT_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$EXT_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$EXT_ROUTING" \
pi -e "$PKG_ROOT" -e "$SENDER_EXTENSION" -e "$FALLBACK_EXTENSION" -p "__seed__" \
  >"$TMPDIR/pi-cook-trigger-extension-source.out" 2>"$TMPDIR/pi-cook-trigger-extension-source.err"

python3 - "$EXT_ROUTING" "$EXT_FALLBACK" "$EXT_CLASSIFIER" "$EXT_PROMPT" <<'PY'
import json
import sys
from pathlib import Path

routing = json.loads(Path(sys.argv[1]).read_text())
fallback = json.loads(Path(sys.argv[2]).read_text())
classifier = Path(sys.argv[3])
driver_prompt = Path(sys.argv[4])

assert routing['action'] == 'continue', 'extension-originated turns should bypass natural-language routing'
assert routing['reason'] == 'extension_source', 'extension-originated turns should record the extension_source bypass reason'
assert fallback['source'] == 'extension', 'extension-originated turns should continue to later extension-source handlers'
assert fallback['text'] == '開始做', 'extension-originated turns should preserve the original extension text'
assert not classifier.exists(), 'extension-originated turns should bypass the trigger classifier entirely'
assert not driver_prompt.exists(), 'extension-originated turns should not queue a /cook driver prompt'
assert not Path('.agent').exists(), 'extension-originated turns should not bootstrap canonical workflow state'
PY

# Explicit /cook command entry should continue through the command path without the input hook interfering.
COOK_ROOT="$TMPDIR/explicit-cook-repo"
COOK_SESSION="$TMPDIR/explicit-cook-session.jsonl"
COOK_ROUTING="$TMPDIR/explicit-cook-routing.json"
COOK_PROMPT="$TMPDIR/explicit-cook-driver-prompt.txt"
mkdir -p "$COOK_ROOT"
cd "$COOK_ROOT"
git init -q
write_session "$COOK_SESSION" "$COOK_ROOT" "$STARTUP_DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$COOK_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$COOK_ROUTING" \
pi --session "$COOK_SESSION" -e "$PKG_ROOT" -p "/cook" \
  >"$TMPDIR/pi-cook-trigger-explicit-cook.out" 2>"$TMPDIR/pi-cook-trigger-explicit-cook.err"

python3 - "$COOK_PROMPT" "$COOK_ROUTING" "$STARTUP_MISSION" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = Path(sys.argv[2])
mission = sys.argv[3]
state = json.loads(Path('.agent/state.json').read_text())

assert 'Start or continue the completion workflow for this repo.' in prompt, 'explicit /cook should keep queuing the shared completion driver prompt'
assert not routing.exists(), 'explicit /cook should bypass the natural-language input-routing snapshot entirely'
assert state['mission_anchor'] == mission, 'explicit /cook should keep the existing startup behavior'
PY

# Classifier timeout/failure should conservatively stop the original input from reaching the main agent.
TIMEOUT_ROOT="$TMPDIR/timeout-repo"
TIMEOUT_SESSION="$TMPDIR/timeout-session.jsonl"
TIMEOUT_ROUTING="$TMPDIR/timeout-routing.json"
TIMEOUT_CLASSIFIER="$TMPDIR/timeout-classifier.json"
TIMEOUT_FALLBACK="$TMPDIR/timeout-fallback.json"
TIMEOUT_PROMPT="$TMPDIR/timeout-driver-prompt.txt"
mkdir -p "$TIMEOUT_ROOT"
cd "$TIMEOUT_ROOT"
git init -q
write_session "$TIMEOUT_SESSION" "$TIMEOUT_ROOT" "$STARTUP_DISCUSSION"

PI_COOK_TRIGGER_FALLBACK_PATH="$TIMEOUT_FALLBACK" \
PI_COOK_TRIGGER_FALLBACK_SOURCE=interactive \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$TIMEOUT_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_FAILURE=timeout \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$TIMEOUT_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$TIMEOUT_ROUTING" \
pi --session "$TIMEOUT_SESSION" -e "$PKG_ROOT" -e "$FALLBACK_EXTENSION" -p "開始做" \
  >"$TMPDIR/pi-cook-trigger-timeout.out" 2>"$TMPDIR/pi-cook-trigger-timeout.err"

python3 - "$TIMEOUT_ROUTING" "$TIMEOUT_CLASSIFIER" "$TIMEOUT_FALLBACK" "$TIMEOUT_PROMPT" "$TMPDIR/pi-cook-trigger-timeout.out" "$TMPDIR/pi-cook-trigger-timeout.err" <<'PY'
import json
import sys
from pathlib import Path

routing = json.loads(Path(sys.argv[1]).read_text())
classifier = json.loads(Path(sys.argv[2]).read_text())
fallback = Path(sys.argv[3])
driver_prompt = Path(sys.argv[4])
output = Path(sys.argv[5]).read_text() + Path(sys.argv[6]).read_text()

assert routing['action'] == 'handled', 'classifier timeout should conservatively handle the original input'
assert routing['reason'] == 'classifier_timeout', 'classifier timeout should record the conservative timeout reason'
assert classifier['result']['status'] == 'timeout', 'classifier timeout should snapshot the timeout result'
assert not fallback.exists(), 'classifier timeout should keep the original interactive input away from later fallback handlers'
assert not driver_prompt.exists(), 'classifier timeout should not queue a /cook driver prompt'
assert not Path('.agent').exists(), 'classifier timeout should not bootstrap canonical workflow state'
assert 'run /cook explicitly' in output, 'classifier timeout should guide the user toward explicit /cook handoff'
PY

echo "cook trigger routing test passed: $TMPDIR"
