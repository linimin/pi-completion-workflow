#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-check] running control-plane validation, tracked .agent contract coverage, slice-surface parity, explicit-/cook parity, startup/refocus/context regressions, canonical evidence artifact, active-slice contract, observability, legacy cleanup, evaluator calibration, and rubric contract coverage"
bash .agent/verify_completion_control_plane.sh
git ls-files --error-unmatch .agent/README.md .agent/mission.md .agent/profile.json .agent/verify_completion_stop.sh .agent/verify_completion_control_plane.sh >/dev/null

echo "[release-check] verifying public /cook parity and explicit-entry docs/help"
python3 - <<'PY'
import re
from pathlib import Path

checks = {
    "README.md": [
        "`/cook` is the explicit workflow boundary for starting, continuing, refocusing, or beginning the next round of long-running repo work.",
        "Only explicit `/cook` enters the workflow. Ordinary prompts stay in the main chat and go straight to the primary agent.",
        "`/cook` is the canonical workflow boundary and manual entry point",
        "Discuss the concrete repo change in the main chat, then run `/cook`",
        "The confirmed startup brief is also preserved there as advisory intake for later re-grounding.",
    ],
    "CHANGELOG.md": [
        "made `/cook` derive a confirmable startup brief from recent discussion before any canonical workflow rewrite, then preserve the confirmed brief in canonical state as advisory intake for later re-grounding",
        "removed inline `/cook` arguments from the shipped entry path again so explicit bare `/cook` is the only public command, and fail closed when recent discussion is insufficient or unreliable",
    ],
    "extensions/completion/index.ts": [
        'description: "/cook workflow: derive a startup brief from recent discussion, then start, continue, refocus, or start the next round from the explicit /cook command"',
        '"/cook failed closed because recent discussion did not produce a clear execution-ready startup brief with Mission/Scope/Constraints/Acceptance for concrete repo changes. Clarify the concrete repo changes in the main chat and rerun /cook."',
    ],
}

forbidden = {
    "README.md": [
        "`/cook <hint>`",
        "Natural-language routing is optional and shipped in two modes",
        "PI_COMPLETION_TRIGGER_MODE",
        "workflow-aware router",
        "Send as normal chat",
        "bash ./scripts/cook-trigger-routing-test.sh",
    ],
    "CHANGELOG.md": ["compatibility" + " shim"],
    "extensions/completion/index.ts": [
        'description: "/cook workflow: start, continue, refocus, or start the next round from an explicit /cook command"',
        '"/cook failed closed because recent discussion did not produce a clear execution-ready Mission/Scope/Constraints/Acceptance proposal for concrete repo changes. Clarify the concrete repo changes in the main chat and rerun /cook."',
        'handleCookNaturalLanguageTrigger',
    ],
}

for path, needles in checks.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"[release-check] missing expected /cook parity text in {path}: {needle}")

for path, needles in forbidden.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle in text:
            raise SystemExit(f"[release-check] found stale compatibility wording in {path}: {needle}")
PY

npm run smoke-test
npm run refocus-test
npm run context-proposal-test
bash ./scripts/role-runner-contract-test.sh
bash ./scripts/canonical-evidence-artifact-test.sh
bash ./scripts/active-slice-contract-test.sh
npm run observability-status-test
bash ./scripts/legacy-cleanup-test.sh
npm run evaluator-calibration-test
npm run rubric-contract-test
npm pack --dry-run >/dev/null

echo "release check passed"
