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

DISCUSSION=$'Mission: Route natural-language handoff into the shared /cook entry.\nScope:\n- Add an input hook before the primary agent starts implementation work.\n- Keep /cook as the canonical workflow boundary.\nConstraints:\n- Do not transform natural-language input into /cook.\nAcceptance:\n- Route execution handoff text into the shared /cook entry behind approval-only confirmation.'
MISSION='Route natural-language handoff into the shared /cook entry.'
ROUTE_CLASSIFIER_OUTPUT='{"intent":"route_to_cook","confidence":0.95,"reason":"The latest input is an execution handoff that should transfer control into /cook.","focusHint":"shared /cook entry handoff","evidence":["current input is a start-execution phrase","recent discussion already defines a concrete workflow mission"],"riskFlags":[]}'
NORMAL_CLASSIFIER_OUTPUT='{"intent":"normal_prompt","confidence":0.82,"reason":"The latest input is still asking the main agent to explain instead of handing control to /cook.","evidence":["the user is still asking for explanation in the main chat"],"riskFlags":["possible-normal-agent-request"]}'

# Assist-mode accepted routing should enter the shared /cook flow before the primary agent sees the handoff.
ROUTE_ROOT="$TMPDIR/route-repo"
ROUTE_SESSION="$TMPDIR/route-session.jsonl"
ROUTE_PROMPT="$TMPDIR/route-driver-prompt.txt"
ROUTE_ROUTING="$TMPDIR/route-routing.json"
ROUTE_CLASSIFIER="$TMPDIR/route-classifier.json"
ROUTE_FALLBACK="$TMPDIR/route-fallback.json"
mkdir -p "$ROUTE_ROOT"
cd "$ROUTE_ROOT"
git init -q
write_session "$ROUTE_SESSION" "$ROUTE_ROOT" "$DISCUSSION"

PI_COOK_TRIGGER_FALLBACK_PATH="$ROUTE_FALLBACK" \
PI_COOK_TRIGGER_FALLBACK_SOURCE=interactive \
PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$ROUTE_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_OUTPUT="$ROUTE_CLASSIFIER_OUTPUT" \
PI_COMPLETION_TEST_TRIGGER_CLASSIFIER_SNAPSHOT_PATH="$ROUTE_CLASSIFIER" \
PI_COMPLETION_TEST_TRIGGER_CONFIRM_ACTION=start \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$ROUTE_ROUTING" \
pi --session "$ROUTE_SESSION" -e "$PKG_ROOT" -e "$FALLBACK_EXTENSION" -p "開始做" \
  >"$TMPDIR/pi-cook-trigger-route.out" 2>"$TMPDIR/pi-cook-trigger-route.err"

python3 - "$ROUTE_PROMPT" "$ROUTE_ROUTING" "$ROUTE_CLASSIFIER" "$ROUTE_FALLBACK" "$MISSION" "$TMPDIR/pi-cook-trigger-route.out" "$TMPDIR/pi-cook-trigger-route.err" <<'PY'
import json
import sys
from pathlib import Path

prompt = Path(sys.argv[1]).read_text()
routing = json.loads(Path(sys.argv[2]).read_text())
classifier = json.loads(Path(sys.argv[3]).read_text())
fallback = Path(sys.argv[4])
mission = sys.argv[5]
output = Path(sys.argv[6]).read_text() + Path(sys.argv[7]).read_text()
profile = json.loads(Path('.agent/profile.json').read_text())
state = json.loads(Path('.agent/state.json').read_text())
plan = json.loads(Path('.agent/plan.json').read_text())
active = json.loads(Path('.agent/active-slice.json').read_text())

assert routing['action'] == 'routed_to_cook', 'accepted handoff should route into the shared /cook entry'
assert routing['reason'] == 'accepted_takeover', 'accepted handoff should record the takeover reason'
assert routing['classificationIntent'] == 'route_to_cook', 'accepted handoff should snapshot the route_to_cook classifier result'
assert routing['focusHint'] == 'shared /cook entry handoff', 'accepted handoff should preserve the classifier focus hint'
assert classifier['result']['status'] == 'classified', 'accepted handoff should snapshot a classified trigger result'
assert classifier['result']['classification']['intent'] == 'route_to_cook', 'accepted handoff classifier snapshot should preserve route_to_cook intent'
assert not fallback.exists(), 'accepted handoff should keep the original interactive input away from later fallback handlers'
assert 'Start or continue the completion workflow for this repo.' in prompt, 'accepted handoff should queue the shared completion driver prompt'
assert 'Canonical routing profile:' in prompt, 'accepted handoff driver prompt should keep the canonical routing metadata'
assert state['mission_anchor'] == mission, 'accepted handoff should bootstrap canonical mission state through the shared /cook entry'
assert plan['mission_anchor'] == mission, 'accepted handoff should bootstrap plan.json through the shared /cook entry'
assert active['mission_anchor'] == mission, 'accepted handoff should bootstrap active-slice.json through the shared /cook entry'
assert profile['task_type'] == 'completion-workflow', 'accepted handoff should keep the canonical task_type'
assert 'Routing natural-language handoff into /cook.' in output, 'accepted handoff should notify that /cook took over'
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
write_session "$NORMAL_SESSION" "$NORMAL_ROOT" "$DISCUSSION"

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
assert routing['classificationIntent'] == 'normal_prompt', 'normal prompts should snapshot the normal_prompt classifier intent'
assert classifier['result']['status'] == 'classified', 'normal prompt pass-through should snapshot a classified trigger result'
assert classifier['result']['classification']['intent'] == 'normal_prompt', 'normal prompt pass-through should preserve the normal_prompt intent'
assert fallback['source'] == 'interactive', 'normal prompt pass-through should reach a later interactive fallback handler'
assert fallback['text'] == 'start by explaining the current repo state', 'normal prompt pass-through should preserve the original prompt text'
assert not Path('.agent').exists(), 'normal prompt pass-through should not bootstrap canonical workflow state'
assert not driver_prompt.exists(), 'normal prompt pass-through should not queue a /cook driver prompt'
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
write_session "$COOK_SESSION" "$COOK_ROOT" "$DISCUSSION"

PI_COMPLETION_CONTEXT_PROPOSAL_ACTION=accept \
PI_COMPLETION_DISABLE_CONTEXT_PROPOSAL_ANALYST=1 \
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_TEST_DRIVER_PROMPT_PATH="$COOK_PROMPT" \
PI_COMPLETION_TEST_TRIGGER_ROUTING_PATH="$COOK_ROUTING" \
pi --session "$COOK_SESSION" -e "$PKG_ROOT" -p "/cook" \
  >"$TMPDIR/pi-cook-trigger-explicit-cook.out" 2>"$TMPDIR/pi-cook-trigger-explicit-cook.err"

python3 - "$COOK_PROMPT" "$COOK_ROUTING" "$MISSION" <<'PY'
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
write_session "$TIMEOUT_SESSION" "$TIMEOUT_ROOT" "$DISCUSSION"

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
