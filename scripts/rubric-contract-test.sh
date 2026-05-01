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
  assertIncludes(file, '`evaluation_profile`');
  assertIncludes(file, '`implementation_surfaces`');
  assertIncludes(file, '`verification_commands`');
  assertIncludes(file, '- `Rubric:`');
  for (const dimension of rubricDimensions) {
    assertIncludes(file, `- \`- ${dimension}: pass|concern|fail - ...\``);
  }
}

assertIncludes('README.md', '## Structured evaluation rubrics');
assertIncludes('README.md', '- `task_type: completion-workflow`');
assertIncludes('README.md', '- `evaluation_profile: completion-rubric-v1`');
assertIncludes('README.md', 'kickoff/reminder/resume text and reviewer/auditor/stop-judge evaluation handoffs so downstream roles can rely on canonical signaling instead of prose inference alone.');
assertIncludes('README.md', 'Reviewer, auditor, and stop-judge dispatch/reminder surfaces now also thread the current active-slice implementation contract');
assertIncludes('README.md', 'Canonical reviewer/auditor/stop-judge transcription now fails closed on malformed rubric-bearing reports');
assertIncludes('README.md', 'npm run rubric-contract-test`, which now exercises reviewer, auditor, and stop-judge transcription paths');
for (const dimension of rubricDimensions) {
  assertIncludes('README.md', `- \`${dimension}\``);
}

assertIncludes('CHANGELOG.md', 'shared structured evaluation-rubric contract');
assertIncludes('CHANGELOG.md', 'added canonical `task_type: completion-workflow` and `evaluation_profile: completion-rubric-v1` signaling across the packaged control-plane defaults, verifier schema, and kickoff/reminder/resume surfaces');
assertIncludes('CHANGELOG.md', 'threaded canonical `evaluation_profile` plus the active-slice implementation contract into reviewer/auditor/stop-judge reminder and dispatch surfaces');
assertIncludes('CHANGELOG.md', 'made reviewer/auditor/stop-judge transcription fail closed on malformed rubric-bearing outputs while still accepting valid reports');
assertIncludes('extensions/completion/index.ts', 'Canonical routing profile:\\n- task_type: ${taskType}\\n- evaluation_profile: ${evaluationProfile}');
assertIncludes('extensions/completion/index.ts', '`Task type: ${currentTaskType(snapshot) ?? "(missing)"}`');
assertIncludes('extensions/completion/index.ts', '`Evaluation profile: ${currentEvaluationProfile(snapshot) ?? "(missing)"}`');
assertIncludes('extensions/completion/index.ts', '`task_type: ${currentTaskType(snapshot) ?? "(missing)"}`');
assertIncludes('extensions/completion/index.ts', '`evaluation_profile: ${currentEvaluationProfile(snapshot) ?? "(missing)"}`');
assertIncludes('extensions/completion/index.ts', 'Canonical evaluation handoff for ${role}:');
assertIncludes('extensions/completion/index.ts', 'buildEvaluationRoleReminderText(snapshot, nextRole)');
assertIncludes('extensions/completion/index.ts', 'roleReporting.transcribeCanonicalRoleReport');
assertIncludes('extensions/completion/role-reporting.js', 'Missing Rubric heading for ${role}.');
assertIncludes('extensions/completion/role-reporting.js', 'Reviewer output cannot mark \'Acceptable as-is: yes\' when any rubric line is fail.');
assertIncludes('extensions/completion/role-reporting.js', 'Stop-judge output cannot mark \'Can the project stop now: yes\' when any rubric line is fail.');
assertIncludes('package.json', '"rubric-contract-test": "bash ./scripts/rubric-contract-test.sh"');
assertIncludes('scripts/release-check.sh', 'npm run rubric-contract-test');
assertIncludes('.agent/verify_completion_stop.sh', 'npm run release-check >/dev/null');
NODE

node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const {
  parseReportFields,
  transcribeCanonicalRoleReport,
} = require('./extensions/completion/role-reporting.js');

const tempRootBase = path.join(process.cwd(), '.agent', 'tmp');
fs.mkdirSync(tempRootBase, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(tempRootBase, 'rubric-role-reporting-'));
const snapshotFiles = {
  sliceHistoryPath: path.join(tempRoot, 'slice-history.jsonl'),
  stopHistoryPath: path.join(tempRoot, 'stop-check-history.jsonl'),
};
fs.writeFileSync(snapshotFiles.sliceHistoryPath, '');
fs.writeFileSync(snapshotFiles.stopHistoryPath, '');

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const reviewerReport = `MISSION ANCHOR: test mission\nRemaining contract IDs: TEST-CONTRACT\nRubric:\n- Contract coverage: pass - Locked acceptance criteria match the committed slice.\n- Correctness risk: pass - No blocking regression is evident.\n- Verification evidence: pass - Deterministic proof was rerun successfully.\n- Docs/state parity: pass - Docs and canonical state are aligned.\nFindings: none.\nAcceptable as-is: yes\nSmallest follow-up slice: none.`;

const reviewerMalformed = `MISSION ANCHOR: test mission\nRemaining contract IDs: TEST-CONTRACT\nRubric:\n- Contract coverage: pass - Locked acceptance criteria match the committed slice.\n- Correctness risk: pass - No blocking regression is evident.\n- Verification evidence: pass - Deterministic proof was rerun successfully.\nFindings: none.\nAcceptable as-is: yes\nSmallest follow-up slice: none.`;

const auditorReport = `MISSION ANCHOR: test mission\nRemaining contract IDs: TEST-CONTRACT\nRubric:\n- Contract coverage: pass - The accepted slice remains satisfied on HEAD.\n- Correctness risk: concern - Remaining planned work still keeps the project open.\n- Verification evidence: pass - Verification was rerun for the accepted slice.\n- Docs/state parity: pass - Canonical state can be reconciled truthfully.\nWhy the project is still not done: One planned contract remains after this accepted slice.\nOpen top-level contract IDs: TEST-CONTRACT\nBlocker count: 0\nHigh-value gap count: 1\nTracked and unignored worktree is clean: yes\nWorktree blockers: none\nNext mandatory slice: next-slice\nStale or conflicting canonical state: no\nPlan truthfully captures remaining slice backlog: yes - one planned slice remains.`;

const auditorMalformed = `MISSION ANCHOR: test mission\nRemaining contract IDs: TEST-CONTRACT\nWhy the project is still not done: One planned contract remains after this accepted slice.\nOpen top-level contract IDs: TEST-CONTRACT\nBlocker count: 0\nHigh-value gap count: 1\nTracked and unignored worktree is clean: yes\nWorktree blockers: none\nNext mandatory slice: next-slice\nStale or conflicting canonical state: no\nPlan truthfully captures remaining slice backlog: yes - one planned slice remains.`;

const stopJudgeReport = `MISSION ANCHOR: test mission\nRemaining contract IDs: none\nRubric:\n- Contract coverage: pass - All implementation slices are accepted on HEAD.\n- Correctness risk: pass - No remaining blocker or high-value gap is evident.\n- Verification evidence: pass - Final verification passes for the current head.\n- Docs/state parity: pass - Docs, config, and canonical state match shipped behavior.\nCan the project stop now: yes\nExact remaining open top-level contract IDs: none\nBlocker count: 0\nHigh-value gap count: 0\nLatest completed slice commit: abcdef1234567890abcdef1234567890abcdef12\nDocs/config/runbooks match shipped behavior: yes\nTracked and unignored worktree is clean: yes\nBrief justification: Current HEAD satisfies the stop criteria.`;

const stopJudgeMalformed = `MISSION ANCHOR: test mission\nRemaining contract IDs: none\nRubric:\n- Contract coverage: fail - A blocking contract is still open.\n- Correctness risk: pass - No additional risk was found.\n- Verification evidence: pass - Verification still passes.\n- Docs/state parity: pass - Docs and state match.\nCan the project stop now: yes\nExact remaining open top-level contract IDs: TEST-CONTRACT\nBlocker count: 1\nHigh-value gap count: 0\nLatest completed slice commit: abcdef1234567890abcdef1234567890abcdef12\nDocs/config/runbooks match shipped behavior: yes\nTracked and unignored worktree is clean: yes\nBrief justification: This should be rejected because the rubric blocks stop.`;

(async () => {
  const reviewed = await transcribeCanonicalRoleReport({
    role: 'completion-reviewer',
    output: reviewerReport,
    reportFields: parseReportFields(reviewerReport),
    snapshotFiles,
    headSha: '1111111111111111111111111111111111111111',
    sliceId: 'slice-review',
    recordedAt: 1,
  });
  assert(reviewed.errors.length === 0, `reviewer valid report should transcribe cleanly: ${reviewed.errors.join(' | ')}`);
  assert(reviewed.appended.includes('reviewed:slice-review'), 'reviewer transcription should append reviewed record');
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 1, 'reviewer transcription should create one slice-history record');

  const reviewerRejected = await transcribeCanonicalRoleReport({
    role: 'completion-reviewer',
    output: reviewerMalformed,
    reportFields: parseReportFields(reviewerMalformed),
    snapshotFiles,
    headSha: '2222222222222222222222222222222222222222',
    sliceId: 'slice-review',
    recordedAt: 2,
  });
  assert(reviewerRejected.errors.some((error) => error.includes('Docs/state parity')), 'reviewer malformed report should be rejected for missing rubric line');
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 1, 'rejected reviewer report must not append history');

  const audited = await transcribeCanonicalRoleReport({
    role: 'completion-auditor',
    output: auditorReport,
    reportFields: parseReportFields(auditorReport),
    snapshotFiles,
    headSha: '3333333333333333333333333333333333333333',
    sliceId: 'slice-audit',
    recordedAt: 3,
  });
  assert(audited.errors.length === 0, `auditor valid report should transcribe cleanly: ${audited.errors.join(' | ')}`);
  assert(audited.appended.includes('audited:slice-audit'), 'auditor transcription should append audited record');
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 2, 'auditor transcription should append a second slice-history record');

  const auditorRejected = await transcribeCanonicalRoleReport({
    role: 'completion-auditor',
    output: auditorMalformed,
    reportFields: parseReportFields(auditorMalformed),
    snapshotFiles,
    headSha: '4444444444444444444444444444444444444444',
    sliceId: 'slice-audit',
    recordedAt: 4,
  });
  assert(auditorRejected.errors.some((error) => error.includes('Missing Rubric heading')), 'auditor malformed report should be rejected without rubric heading');
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 2, 'rejected auditor report must not append history');

  const judged = await transcribeCanonicalRoleReport({
    role: 'completion-stop-judge',
    output: stopJudgeReport,
    reportFields: parseReportFields(stopJudgeReport),
    snapshotFiles,
    headSha: '5555555555555555555555555555555555555555',
    recordedAt: 5,
  });
  assert(judged.errors.length === 0, `stop-judge valid report should transcribe cleanly: ${judged.errors.join(' | ')}`);
  assert(judged.appended.includes('judgment:555555555555'), 'stop-judge transcription should append judgment record');
  assert(readJsonl(snapshotFiles.stopHistoryPath).length === 1, 'stop-judge transcription should create one judgment record');

  const judgeRejected = await transcribeCanonicalRoleReport({
    role: 'completion-stop-judge',
    output: stopJudgeMalformed,
    reportFields: parseReportFields(stopJudgeMalformed),
    snapshotFiles,
    headSha: '6666666666666666666666666666666666666666',
    recordedAt: 6,
  });
  assert(judgeRejected.errors.some((error) => error.includes("Can the project stop now: yes")), 'stop-judge malformed report should be rejected when fail rubric contradicts yes verdict');
  assert(readJsonl(snapshotFiles.stopHistoryPath).length === 1, 'rejected stop-judge report must not append judgment history');

  fs.rmSync(tempRoot, { recursive: true, force: true });
})().catch((error) => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE

echo "rubric contract test passed"
