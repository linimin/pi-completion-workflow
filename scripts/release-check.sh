#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-check] running control-plane validation, /cook public parity, assist-mode natural-language handoff coverage, role-runner extraction, startup/refocus/context regressions, canonical evidence artifact, active-slice contract, observability, legacy cleanup, evaluator calibration, and rubric contract coverage"
bash .agent/verify_completion_control_plane.sh

echo "[release-check] verifying public /cook parity and assist-mode natural-language handoff docs/help"
python3 - <<'PY'
import re
from pathlib import Path

checks = {
    "README.md": [
        "`/cook` supports both bare discussion-driven startup and optional inline intent hints.",
        "assist-mode natural-language handoff that can offer to enter the same `/cook` flow before the primary agent starts implementation work",
        "Execution handoff phrases like `開始做`, `開始實作`, or `go ahead` can also trigger an assist-mode confirmation asking whether `/cook` should take over.",
        "Assist-mode natural-language handoff is optional. It only offers to enter the same `/cook` flow from recent discussion; explicit `/cook` remains the canonical workflow boundary and the fallback when the trigger is unclear or unavailable.",
        "`/cook <hint>` acts as a high-priority intent hint that helps proposal derivation interpret the recent discussion",
        "clarify the mission in the main chat before rerunning `/cook`",
        "Matching or unclear discussion resumes from canonical `.agent/**` state.",
        "approval-only Start/Cancel gate",
        "Start new workflow from recent discussion",
        "fails closed instead of guessing",
        "README/CHANGELOG updates still count as concrete repo changes",
        "assistant-produced summaries and plan/spec/design-doc/proposal-only artifacts do not",
        "Assistant/summary artifacts or plan/spec/design-doc/proposal-only context do not refocus the workflow.",
        "Optional `/cook <hint>` text biases that routing and candidate ranking toward the hinted implementation intent",
        "bash ./scripts/cook-trigger-routing-test.sh",
    ],
    "CHANGELOG.md": [
        "documented the shipped assist-mode natural-language handoff that can offer to route `開始做`, `開始實作`, or `go ahead` style execution handoffs into the canonical `/cook` flow",
        "added `bash ./scripts/cook-trigger-routing-test.sh` to `npm run release-check` so packaged release parity now covers the natural-language takeover path",
        "restored optional `/cook <hint>` support as a soft intent hint that biases context analysis, proposal ranking, active-workflow disambiguation, and next-round startup without bypassing fail-closed routing or the approval-only Start/Cancel gate",
        "removed inline `/cook <text>` argument support so bare `/cook` is now the only supported workflow entrypoint",
        "historically allowed `/cook <hint>` as an analyst-only high-priority prompt",
    ],
    "extensions/completion/index.ts": [
        'description: "/cook workflow: start, continue, refocus, or start the next round; assist-mode natural-language handoff can offer the same /cook boundary"',
        'const COOK_BARE_ONLY_GUIDANCE =',
        '"/cook remains the canonical workflow boundary. Assist-mode natural-language handoff can offer to enter the same /cook flow before implementation starts, while mission selection still comes from recent discussion, repo truth, and the approval-only confirmation flow."',
        '"/cook failed closed because recent discussion did not produce a clear execution-ready Mission/Scope/Constraints/Acceptance proposal for concrete repo changes. Natural-language handoff only offers to enter the same /cook flow, so clarify the concrete repo changes in the main chat and rerun /cook."',
    ],
}

forbidden = {
    "README.md": ["compatibility" + " shim", "optional inline /cook hint"],
    "CHANGELOG.md": ["compatibility" + " shim"],
    "extensions/completion/index.ts": ["temporary" + " compatibility" + " shim, pass /cook", "optional inline /cook hint"],
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
