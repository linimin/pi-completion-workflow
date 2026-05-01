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
  assertIncludes(file, 'canonical `task_type` and `evaluation_profile` signaling');
  assertIncludes(file, 'routing metadata only; later slices may still add stricter profile-aware rubric-output enforcement');
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
assertIncludes('README.md', '- `task_type: completion-workflow`');
assertIncludes('README.md', '- `evaluation_profile: completion-rubric-v1`');
assertIncludes('README.md', 'kickoff/reminder/resume text so downstream roles can rely on canonical signaling instead of prose inference alone.');
assertIncludes('README.md', 'Deterministic verification for this packaged contract lives in `npm run rubric-contract-test`, while the bootstrap/refocus/context regressions plus control-plane verifier now fail closed when required canonical signaling is missing.');
for (const dimension of rubricDimensions) {
  assertIncludes('README.md', `- \`${dimension}\``);
}

assertIncludes('CHANGELOG.md', 'shared structured evaluation-rubric contract');
assertIncludes('CHANGELOG.md', 'added canonical `task_type: completion-workflow` and `evaluation_profile: completion-rubric-v1` signaling across the packaged control-plane defaults, verifier schema, and kickoff/reminder/resume surfaces');
assertIncludes('CHANGELOG.md', 'strengthened the smoke/refocus/context regressions so bootstrap and refocus preserve the new canonical signaling and fail closed when required `task_type` / `evaluation_profile` fields are removed');
assertIncludes('extensions/completion/index.ts', 'Canonical routing profile:\\n- task_type: ${taskType}\\n- evaluation_profile: ${evaluationProfile}');
assertIncludes('extensions/completion/index.ts', '`Task type: ${currentTaskType(snapshot) ?? "(missing)"}`');
assertIncludes('extensions/completion/index.ts', '`Evaluation profile: ${currentEvaluationProfile(snapshot) ?? "(missing)"}`');
assertIncludes('extensions/completion/index.ts', '`task_type: ${currentTaskType(snapshot) ?? "(missing)"}`');
assertIncludes('extensions/completion/index.ts', '`evaluation_profile: ${currentEvaluationProfile(snapshot) ?? "(missing)"}`');
assertIncludes('package.json', '"rubric-contract-test": "bash ./scripts/rubric-contract-test.sh"');
assertIncludes('scripts/release-check.sh', 'npm run rubric-contract-test');
assertIncludes('.agent/verify_completion_stop.sh', 'npm run release-check >/dev/null');
NODE

echo "rubric contract test passed"
