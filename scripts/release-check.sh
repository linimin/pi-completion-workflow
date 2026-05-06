#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[release-check] running control-plane validation, bare /cook parity, startup/refocus/context regressions, canonical evidence artifact, active-slice contract, observability, evaluator calibration, and rubric contract coverage"
bash .agent/verify_completion_control_plane.sh

echo "[release-check] verifying public bare /cook parity"
python3 - <<'PY'
import re
from pathlib import Path

checks = {
    "README.md": [
        "Bare `/cook` is the only supported workflow entrypoint.",
        "clarify the mission in the main chat before rerunning bare `/cook`",
        "Matching or unclear discussion resumes from canonical `.agent/**` state.",
        "approval-only Start/Cancel gate",
        "Start new workflow from recent discussion",
        "fails closed instead of guessing",
        "README/CHANGELOG updates still count as concrete repo changes",
        "assistant-produced summaries and plan/spec/design-doc/proposal-only artifacts do not",
        "Assistant/summary artifacts or plan/spec/design-doc/proposal-only context do not refocus the workflow.",
    ],
    "CHANGELOG.md": [
        "bare `/cook` as the only supported workflow entrypoint",
        "clarify the mission before rerunning bare `/cook`",
        "packaged parity now fails closed on the bare-only contract",
        "that old inline-argument path is no longer supported now that bare `/cook` is the only public entrypoint",
        "README/CHANGELOG/docs-only deliverables as concrete repo-change missions",
        "ignore assistant/branch/compaction summary artifacts for startup/refocus readiness",
        "plan/spec/design-doc/proposal-only context without rewriting canonical state",
    ],
    "extensions/completion/index.ts": [
        'description: "Discussion-driven /cook workflow: start, continue, refocus, or start the next round"',
        "Inline /cook arguments are no longer supported. Clarify the mission in the main chat and rerun bare /cook.",
        "Bare /cook failed closed because recent discussion did not contain a clear execution-ready Mission/Scope/Constraints/Acceptance proposal for concrete repo changes. Clarify the concrete repo changes in the main chat and rerun bare /cook.",
    ],
}

forbidden = {
    "README.md": ["compatibility" + " shim"],
    "CHANGELOG.md": ["compatibility" + " shim"],
    "extensions/completion/index.ts": ["temporary" + " compatibility" + " shim, pass /cook"],
}

public_doc_paths = [
    Path("README.md"),
    Path("CHANGELOG.md"),
    Path("PUBLISHING.md"),
]
inline_cook_pattern = re.compile(r"/cook\s*<[^>]+>")

for path, needles in checks.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"[release-check] missing expected bare /cook parity text in {path}: {needle}")

for path, needles in forbidden.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle in text:
            raise SystemExit(f"[release-check] found stale compatibility wording in {path}: {needle}")

for path in public_doc_paths:
    text = path.read_text()
    match = inline_cook_pattern.search(text)
    if match:
        raise SystemExit(
            f"[release-check] found unsupported inline /cook syntax in {path}: {match.group(0)}"
        )
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
