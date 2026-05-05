#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-check] running control-plane validation, public /cook parity, startup/refocus/context regressions, canonical evidence artifact, active-slice contract, observability, evaluator calibration, and rubric contract coverage"
bash .agent/verify_completion_control_plane.sh

echo "[release-check] verifying public /cook single-command parity"
python3 - <<'PY'
from pathlib import Path

checks = {
    "README.md": [
        "Bare `/cook` is now the primary workflow entrypoint.",
        "`/cook <text>` is still supported as a temporary compatibility shim",
        "Matching or unclear discussion resumes from canonical `.agent/**` state.",
        "approval-only Start/Cancel gate",
        "Start new workflow from recent discussion",
        "fails closed instead of guessing",
    ],
    "CHANGELOG.md": [
        "single public discussion-first workflow command",
        "temporary compatibility shim",
        "approval-only Start/Cancel gate",
        "fail-closed ambiguous-discussion behavior",
        "release-gated public-parity assertions",
    ],
    "extensions/completion/index.ts": [
        'description: "Discussion-driven /cook workflow: start, continue, refocus, or start the next round"',
        "temporary compatibility shim, pass /cook <text>",
    ],
}

for path, needles in checks.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"[release-check] missing expected public /cook parity text in {path}: {needle}")
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
