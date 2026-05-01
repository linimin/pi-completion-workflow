#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node <<'NODE'
const fs = require('node:fs');

const read = (file) => fs.readFileSync(file, 'utf8');
const assertIncludes = (file, snippet) => {
  const text = read(file);
  if (!text.includes(snippet)) {
    console.error(`${file} is missing required rubric-contract text: ${snippet}`);
    process.exit(1);
  }
};

const rubricHeading = '## Structured Evaluation Rubric Foundation';
const rubricDimensions = [
  'Contract coverage',
  'Correctness risk',
  'Verification evidence',
  'Docs/state parity',
];
const verdictSnippets = [
  '`pass` — no material issue remains',
  '`concern` — a real caveat or remaining gap exists',
  '`fail` — a blocking issue or contradictory truth exists',
];

for (const file of [
  'skills/completion-protocol/SKILL.md',
  'skills/completion-protocol/references/completion.md',
]) {
  assertIncludes(file, rubricHeading);
  assertIncludes(file, 'This foundation is a prompt/report contract only. It does **not** add canonical `task_type` or `evaluation_profile` schema yet; later slices may wire those through the control plane.');
  assertIncludes(file, '- `Rubric:`');
  for (const dimension of rubricDimensions) {
    assertIncludes(file, `- \`- ${dimension}: pass|concern|fail - ...\``);
  }
  for (const snippet of verdictSnippets) {
    assertIncludes(file, snippet);
  }
}

for (const file of [
  'agents/completion-reviewer.md',
  'agents/completion-auditor.md',
  'agents/completion-stop-judge.md',
]) {
  assertIncludes(file, 'Always emit the shared rubric section');
  assertIncludes(file, 'Use these exact rubric dimension names and verdict words');
  assertIncludes(file, '- `Rubric:`');
  for (const dimension of rubricDimensions) {
    assertIncludes(file, `- \`- ${dimension}: pass|concern|fail - ...\``);
  }
}

assertIncludes('README.md', '## Structured evaluation rubrics');
assertIncludes('README.md', 'Deterministic verification for this packaged contract lives in `npm run rubric-contract-test`, and `npm run release-check` now includes that coverage.');
for (const dimension of rubricDimensions) {
  assertIncludes('README.md', `- \`${dimension}\``);
}

assertIncludes('CHANGELOG.md', 'shared structured evaluation-rubric contract');
assertIncludes('CHANGELOG.md', 'added deterministic `rubric-contract-test` coverage and wired it into `npm run release-check`');
assertIncludes('package.json', '"rubric-contract-test": "bash ./scripts/rubric-contract-test.sh"');
assertIncludes('scripts/release-check.sh', 'npm run rubric-contract-test');
assertIncludes('.agent/verify_completion_stop.sh', 'npm run release-check >/dev/null');
NODE

echo "rubric contract test passed"
