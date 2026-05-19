#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-check] running control-plane validation, /cook public parity, workflow-aware router coverage, role-runner extraction, startup/refocus/context regressions, canonical evidence artifact, active-slice contract, observability, legacy cleanup, evaluator calibration, and rubric contract coverage"
bash .agent/verify_completion_control_plane.sh

echo "[release-check] verifying public /cook parity and workflow-aware router docs/help"
python3 - <<'PY'
import re
from pathlib import Path

checks = {
    "README.md": [
        "Natural-language routing is optional and shipped in two modes: `off` disables it, and `router` reviews each non-bypass user turn before implementation starts while leaving ordinary questions in the main chat.",
        "Set `PI_COMPLETION_TRIGGER_MODE` before starting Pi if you want to change how natural-language routing behaves:",
        "- `off` — natural-language routing is disabled. Only explicit `/cook` or `/cook <hint>` can enter the workflow.",
        "- `router` *(default)* — the workflow-aware router reviews each non-bypass normal user turn before implementation starts.",
        "the original message only reaches the normal chat path if you explicitly choose **Send as normal chat**",
        "Explicit `/cook` is always the canonical fallback, even when natural-language routing is enabled in `router` mode.",
        "router-mode false positives and classifier failures stay fail-closed unless you explicitly choose **Send as normal chat**",
        "bash ./scripts/cook-trigger-routing-test.sh",
    ],
    "CHANGELOG.md": [
        "removed assist mode from public routing behavior so natural-language entry is now either off or router, and made router the default trigger mode while keeping `/cook` as the canonical workflow boundary",
        "documented the explicit router-mode **Send as normal chat** recovery path as a user choice, not as a silent downgrade, and kept public copy scoped to currently shipped router behavior rather than future auto-mode plans",
        "made `npm run release-check` fail closed on the shipped workflow-aware router docs/help contract while continuing to rerun `bash ./scripts/cook-trigger-routing-test.sh` alongside the existing `/cook` smoke/refocus/context regressions",
    ],
    "extensions/completion/index.ts": [
        'description: "/cook workflow: start, continue, refocus, or start the next round; /cook stays canonical while natural-language routing can be off or router"',
        'const COOK_BARE_ONLY_GUIDANCE =',
        '"/cook remains the canonical workflow boundary. Natural-language routing can stay off or run in router mode to review each non-bypass user turn before implementation starts, but the shared /cook flow still owns mission selection and confirmation."',
        '"/cook failed closed because recent discussion did not produce a clear execution-ready Mission/Scope/Constraints/Acceptance proposal for concrete repo changes. Router mode only offers the same /cook flow, and router recovery only replays to normal chat when you explicitly choose Send as normal chat, so clarify the concrete repo changes in the main chat and rerun /cook."',
    ],
}

forbidden = {
    "README.md": [
        "Assist-mode natural-language handoff can also offer to enter that same `/cook` flow before the primary agent starts implementation work, but `/cook` remains the canonical workflow boundary.",
        "## Natural-language handoff (assist mode)",
        "`assist`",
    ],
    "CHANGELOG.md": ["compatibility" + " shim"],
    "extensions/completion/index.ts": [
        'description: "/cook workflow: start, continue, refocus, or start the next round; assist-mode natural-language handoff can offer the same /cook boundary"',
        '"/cook remains the canonical workflow boundary. Assist-mode natural-language handoff can offer to enter the same /cook flow before implementation starts, while mission selection still comes from recent discussion, repo truth, and the approval-only confirmation flow."',
        '"/cook failed closed because recent discussion did not produce a clear execution-ready Mission/Scope/Constraints/Acceptance proposal for concrete repo changes. Natural-language handoff only offers to enter the same /cook flow, so clarify the concrete repo changes in the main chat and rerun /cook."',
        'assist, or router',
        'Assist and router modes only offer the same /cook flow',
        'run in assist mode',
        "temporary" + " compatibility" + " shim, pass /cook",
        "optional inline /cook hint",
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

bash ./scripts/cook-trigger-routing-test.sh
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
