#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-check] running control-plane validation, bare /cook parity, startup/refocus/context regressions, canonical evidence artifact, active-slice contract, observability, evaluator calibration, and rubric contract coverage"
bash .agent/verify_completion_control_plane.sh

echo "[release-check] verifying public /cook parity"
python3 - <<'PY'
import re
from pathlib import Path

checks = {
    "README.md": [
        "Bare `/cook` is the only supported workflow entrypoint.",
        "`/cook <text>` is no longer supported; put mission text in the main chat, then rerun bare `/cook`.",
        "clarify the mission in the main chat before rerunning bare `/cook`",
        "Matching or unclear discussion resumes from canonical `.agent/**` state.",
        "approval-only Start/Cancel gate",
        "Start new workflow from recent discussion",
        "fails closed instead of guessing",
        "README/CHANGELOG updates still count as concrete repo changes",
        "assistant-produced summaries and plan/spec/design-doc/proposal-only artifacts do not",
        "Assistant/summary artifacts or plan/spec/design-doc/proposal-only context do not refocus the workflow.",
        "`/cook <text>` is rejected without running proposal routing or rewriting workflow state.",
    ],
    "CHANGELOG.md": [
        "removed inline `/cook <text>` argument support so bare `/cook` is now the only supported workflow entrypoint",
        "packaged release parity fail closed when command arguments are passed instead of discussion driving proposal derivation",
        "historically allowed `/cook <hint>` as an analyst-only high-priority prompt",
        "that inline-argument path has since been removed so bare `/cook` is now the only supported entrypoint",
    ],
    "extensions/completion/index.ts": [
        'description: "Bare /cook workflow: start, continue, refocus, or start the next round"',
        'const COOK_BARE_ONLY_GUIDANCE =',
        '"/cook only supports the bare /cook entrypoint. Move mission text into the main chat, then rerun /cook."',
        '"/cook failed closed because recent discussion did not produce a clear execution-ready Mission/Scope/Constraints/Acceptance proposal for concrete repo changes. Clarify the concrete repo changes in the main chat and rerun /cook."',
    ],
}

forbidden = {
    "README.md": ["compatibility" + " shim", "/cook <hint>", "optional inline /cook hint"],
    "CHANGELOG.md": ["compatibility" + " shim"],
    "extensions/completion/index.ts": ["temporary" + " compatibility" + " shim, pass /cook", "inline /cook hint", "optional inline /cook hint"],
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
bash ./scripts/canonical-evidence-artifact-test.sh
bash ./scripts/active-slice-contract-test.sh
npm run observability-status-test
npm run evaluator-calibration-test
npm run rubric-contract-test
npm pack --dry-run >/dev/null

echo "release check passed"
