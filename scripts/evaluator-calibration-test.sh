#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const {
  parseReportFields,
  transcribeCanonicalRoleReport,
} = require('./extensions/completion/role-reporting.js');

const read = (file) => fs.readFileSync(file, 'utf8');
const assertIncludes = (file, snippet) => {
  const text = read(file);
  if (!text.includes(snippet)) {
    throw new Error(`${file} is missing required evaluator-calibration text: ${snippet}`);
  }
};

assertIncludes('package.json', '"evaluator-calibration-test": "bash ./scripts/evaluator-calibration-test.sh"');
assertIncludes('scripts/release-check.sh', 'npm run evaluator-calibration-test');
assertIncludes('.agent/verify_completion_stop.sh', 'npm run evaluator-calibration-test >/dev/null');
assertIncludes('README.md', 'Evaluator calibration now also fails closed on semantically lenient but well-formed reports.');
assertIncludes('README.md', '`npm run evaluator-calibration-test` drives the packaged transcription path through reviewer yes-with-follow-up, auditor open-contracts-with-`Next mandatory slice: none`, and stop-judge yes-with-open-contracts fixtures while still accepting truthful passing reports.');
assertIncludes('README.md', 'It also rejects the reproducible `none; ...` bypass family for reviewer follow-up, auditor worktree blockers, and stop-judge open-contract reporting, while still accepting only the exact reviewer routing text `Smallest follow-up slice: none; proceed to completion-auditor.` with terminal punctuation or whitespace only.');
assertIncludes('README.md', 'includes deterministic active-slice contract coverage plus observability coverage, evaluator calibration, and the rubric-contract regression');
assertIncludes('CHANGELOG.md', 'added evaluator calibration fixtures for semantically lenient but well-formed reviewer/auditor/stop-judge reports');
assertIncludes('CHANGELOG.md', 'tightened the reproducible `none; ...` reviewer/auditor/stop-judge bypass checks while still accepting only the exact reviewer `none; proceed to completion-auditor` routing allowance with terminal punctuation or whitespace only');
assertIncludes('CHANGELOG.md', 'wired `npm run evaluator-calibration-test` into `npm run release-check` and `.agent/verify_completion_stop.sh`');
assertIncludes('CHANGELOG.md', 'fixed the smoke auto-resume prompt regression');
assertIncludes('extensions/completion/role-reporting.js', 'Reviewer output cannot mark \'Acceptable as-is: yes\' while naming a follow-up slice other than none.');
assertIncludes('extensions/completion/role-reporting.js', 'Auditor output cannot mark \'Tracked and unignored worktree is clean: yes\' while listing worktree blockers.');
assertIncludes('extensions/completion/role-reporting.js', 'Auditor output cannot leave \'Next mandatory slice\' as none while open contracts, blockers, or high-value gaps remain.');
assertIncludes('extensions/completion/role-reporting.js', 'Stop-judge output cannot mark \'Can the project stop now: yes\' while naming remaining open top-level contract IDs.');
assertIncludes('extensions/completion/role-reporting.js', 'Stop-judge output cannot mark \'Can the project stop now: yes\' when Blocker count is greater than 0.');

const tempRootBase = path.join(process.cwd(), '.agent', 'tmp');
fs.mkdirSync(tempRootBase, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(tempRootBase, 'evaluator-calibration-'));
const snapshotFiles = {
  sliceHistoryPath: path.join(tempRoot, 'slice-history.jsonl'),
  stopHistoryPath: path.join(tempRoot, 'stop-check-history.jsonl'),
};
fs.writeFileSync(snapshotFiles.sliceHistoryPath, '');
fs.writeFileSync(snapshotFiles.stopHistoryPath, '');

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const reviewerPass = `MISSION ANCHOR: test mission
Remaining contract IDs: TEST-CONTRACT
Rubric:
- Contract coverage: pass - Locked acceptance criteria match the committed slice.
- Correctness risk: pass - No blocking regression is evident.
- Verification evidence: pass - Deterministic proof was rerun successfully.
- Docs/state parity: pass - Docs and canonical state are aligned.
Findings: none.
Acceptable as-is: yes
Smallest follow-up slice: none; proceed to completion-auditor.`;

const reviewerLenient = `MISSION ANCHOR: test mission
Remaining contract IDs: TEST-CONTRACT
Rubric:
- Contract coverage: pass - Locked acceptance criteria match the committed slice.
- Correctness risk: pass - No blocking regression is evident.
- Verification evidence: pass - Deterministic proof was rerun successfully.
- Docs/state parity: pass - Docs and canonical state are aligned.
Findings: none.
Acceptable as-is: yes
Smallest follow-up slice: tighten docs before audit.`;

const reviewerNonePrefixedLenient = `MISSION ANCHOR: test mission
Remaining contract IDs: TEST-CONTRACT
Rubric:
- Contract coverage: pass - Locked acceptance criteria match the committed slice.
- Correctness risk: pass - No blocking regression is evident.
- Verification evidence: pass - Deterministic proof was rerun successfully.
- Docs/state parity: pass - Docs and canonical state are aligned.
Findings: none.
Acceptable as-is: yes
Smallest follow-up slice: none; tighten docs before audit.`;

const reviewerTrailingTextAfterRoutingLenient = `MISSION ANCHOR: test mission
Remaining contract IDs: TEST-CONTRACT
Rubric:
- Contract coverage: pass - Locked acceptance criteria match the committed slice.
- Correctness risk: pass - No blocking regression is evident.
- Verification evidence: pass - Deterministic proof was rerun successfully.
- Docs/state parity: pass - Docs and canonical state are aligned.
Findings: none.
Acceptable as-is: yes
Smallest follow-up slice: none; proceed to completion-auditor; tighten docs before audit.`;

const auditorPass = `MISSION ANCHOR: test mission
Remaining contract IDs: TEST-CONTRACT
Rubric:
- Contract coverage: pass - The accepted slice remains satisfied on HEAD.
- Correctness risk: concern - One planned contract still keeps the project open.
- Verification evidence: pass - Verification was rerun for the accepted slice.
- Docs/state parity: pass - Canonical state can be reconciled truthfully.
Why the project is still not done: One planned contract remains after this accepted slice.
Open top-level contract IDs: TEST-CONTRACT
Blocker count: 0
High-value gap count: 1
Tracked and unignored worktree is clean: yes
Worktree blockers: none
Next mandatory slice: next-slice
Stale or conflicting canonical state: no
Plan truthfully captures remaining slice backlog: yes - one planned slice remains.`;

const auditorLenient = `MISSION ANCHOR: test mission
Remaining contract IDs: TEST-CONTRACT
Rubric:
- Contract coverage: pass - The accepted slice remains satisfied on HEAD.
- Correctness risk: concern - One planned contract still keeps the project open.
- Verification evidence: pass - Verification was rerun for the accepted slice.
- Docs/state parity: pass - Canonical state can be reconciled truthfully.
Why the project is still not done: One planned contract remains after this accepted slice.
Open top-level contract IDs: TEST-CONTRACT
Blocker count: 0
High-value gap count: 1
Tracked and unignored worktree is clean: yes
Worktree blockers: modified README.md
Next mandatory slice: none.
Stale or conflicting canonical state: no
Plan truthfully captures remaining slice backlog: yes - one planned slice remains.`;

const auditorNonePrefixedLenient = `MISSION ANCHOR: test mission
Remaining contract IDs: TEST-CONTRACT
Rubric:
- Contract coverage: pass - The accepted slice remains satisfied on HEAD.
- Correctness risk: concern - One planned contract still keeps the project open.
- Verification evidence: pass - Verification was rerun for the accepted slice.
- Docs/state parity: pass - Canonical state can be reconciled truthfully.
Why the project is still not done: One planned contract remains after this accepted slice.
Open top-level contract IDs: TEST-CONTRACT
Blocker count: 0
High-value gap count: 1
Tracked and unignored worktree is clean: yes
Worktree blockers: none; modified README.md
Next mandatory slice: next-slice
Stale or conflicting canonical state: no
Plan truthfully captures remaining slice backlog: yes - one planned slice remains.`;

const stopJudgePass = `MISSION ANCHOR: test mission
Remaining contract IDs: none
Rubric:
- Contract coverage: pass - All implementation slices are accepted on HEAD.
- Correctness risk: pass - No remaining blocker or high-value gap is evident.
- Verification evidence: pass - Final verification passes for the current head.
- Docs/state parity: pass - Docs, config, and canonical state match shipped behavior.
Can the project stop now: yes
Exact remaining open top-level contract IDs: none
Blocker count: 0
High-value gap count: 0
Latest completed slice commit: abcdef1234567890abcdef1234567890abcdef12
Docs/config/runbooks match shipped behavior: yes
Tracked and unignored worktree is clean: yes
Brief justification: Current HEAD satisfies the stop criteria.`;

const stopJudgeLenient = `MISSION ANCHOR: test mission
Remaining contract IDs: none
Rubric:
- Contract coverage: pass - All implementation slices are accepted on HEAD.
- Correctness risk: pass - No additional risk was found.
- Verification evidence: pass - Final verification passes for the current head.
- Docs/state parity: pass - Docs, config, and canonical state match shipped behavior.
Can the project stop now: yes
Exact remaining open top-level contract IDs: TEST-CONTRACT
Blocker count: 1
High-value gap count: 0
Latest completed slice commit: abcdef1234567890abcdef1234567890abcdef12
Docs/config/runbooks match shipped behavior: yes
Tracked and unignored worktree is clean: yes
Brief justification: This should be rejected because remaining contracts and blockers still exist.`;

const stopJudgeNonePrefixedLenient = `MISSION ANCHOR: test mission
Remaining contract IDs: none
Rubric:
- Contract coverage: pass - All implementation slices are accepted on HEAD.
- Correctness risk: pass - No additional risk was found.
- Verification evidence: pass - Final verification passes for the current head.
- Docs/state parity: pass - Docs, config, and canonical state match shipped behavior.
Can the project stop now: yes
Exact remaining open top-level contract IDs: none; TEST-CONTRACT
Blocker count: 0
High-value gap count: 0
Latest completed slice commit: abcdef1234567890abcdef1234567890abcdef12
Docs/config/runbooks match shipped behavior: yes
Tracked and unignored worktree is clean: yes
Brief justification: This should be rejected because remaining contracts still exist behind a none-prefixed field.`;

(async () => {
  const reviewed = await transcribeCanonicalRoleReport({
    role: 'completion-reviewer',
    output: reviewerPass,
    reportFields: parseReportFields(reviewerPass),
    snapshotFiles,
    headSha: '1111111111111111111111111111111111111111',
    sliceId: 'slice-review',
    recordedAt: 1,
  });
  assert(reviewed.errors.length === 0, `reviewer passing fixture should transcribe cleanly: ${reviewed.errors.join(' | ')}`);
  assert(reviewed.appended.includes('reviewed:slice-review'), 'reviewer passing fixture should append a reviewed record');
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 1, 'reviewer passing fixture should create one slice-history record');

  const reviewerRejected = await transcribeCanonicalRoleReport({
    role: 'completion-reviewer',
    output: reviewerLenient,
    reportFields: parseReportFields(reviewerLenient),
    snapshotFiles,
    headSha: '2222222222222222222222222222222222222222',
    sliceId: 'slice-review',
    recordedAt: 2,
  });
  assert(
    reviewerRejected.errors.some((error) => error.includes('follow-up slice other than none')),
    `reviewer lenient fixture should be rejected for a yes verdict with a follow-up slice: ${reviewerRejected.errors.join(' | ')}`,
  );
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 1, 'rejected reviewer fixture must not append history');

  const reviewerNonePrefixedRejected = await transcribeCanonicalRoleReport({
    role: 'completion-reviewer',
    output: reviewerNonePrefixedLenient,
    reportFields: parseReportFields(reviewerNonePrefixedLenient),
    snapshotFiles,
    headSha: '7777777777777777777777777777777777777777',
    sliceId: 'slice-review',
    recordedAt: 7,
  });
  assert(
    reviewerNonePrefixedRejected.errors.some((error) => error.includes('follow-up slice other than none')),
    `reviewer none-prefixed lenient fixture should be rejected for a yes verdict with contradictory routing text: ${reviewerNonePrefixedRejected.errors.join(' | ')}`,
  );
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 1, 'rejected none-prefixed reviewer fixture must not append history');

  const reviewerTrailingTextAfterRoutingRejected = await transcribeCanonicalRoleReport({
    role: 'completion-reviewer',
    output: reviewerTrailingTextAfterRoutingLenient,
    reportFields: parseReportFields(reviewerTrailingTextAfterRoutingLenient),
    snapshotFiles,
    headSha: '1010101010101010101010101010101010101010',
    sliceId: 'slice-review',
    recordedAt: 10,
  });
  assert(
    reviewerTrailingTextAfterRoutingRejected.errors.some((error) => error.includes('follow-up slice other than none')),
    `reviewer routing-trailing-text fixture should be rejected for extra text after the exact completion-auditor allowance: ${reviewerTrailingTextAfterRoutingRejected.errors.join(' | ')}`,
  );
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 1, 'rejected reviewer routing-trailing-text fixture must not append history');

  const audited = await transcribeCanonicalRoleReport({
    role: 'completion-auditor',
    output: auditorPass,
    reportFields: parseReportFields(auditorPass),
    snapshotFiles,
    headSha: '3333333333333333333333333333333333333333',
    sliceId: 'slice-audit',
    recordedAt: 3,
  });
  assert(audited.errors.length === 0, `auditor passing fixture should transcribe cleanly: ${audited.errors.join(' | ')}`);
  assert(audited.appended.includes('audited:slice-audit'), 'auditor passing fixture should append an audited record');
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 2, 'auditor passing fixture should append a second slice-history record');

  const auditorRejected = await transcribeCanonicalRoleReport({
    role: 'completion-auditor',
    output: auditorLenient,
    reportFields: parseReportFields(auditorLenient),
    snapshotFiles,
    headSha: '4444444444444444444444444444444444444444',
    sliceId: 'slice-audit',
    recordedAt: 4,
  });
  assert(
    auditorRejected.errors.some((error) => error.includes('listing worktree blockers')),
    `auditor lenient fixture should reject clean-yes reports that still list worktree blockers: ${auditorRejected.errors.join(' | ')}`,
  );
  assert(
    auditorRejected.errors.some((error) => error.includes("Next mandatory slice") && error.includes('none')),
    `auditor lenient fixture should reject open-work reports with no next mandatory slice: ${auditorRejected.errors.join(' | ')}`,
  );
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 2, 'rejected auditor fixture must not append history');

  const auditorNonePrefixedRejected = await transcribeCanonicalRoleReport({
    role: 'completion-auditor',
    output: auditorNonePrefixedLenient,
    reportFields: parseReportFields(auditorNonePrefixedLenient),
    snapshotFiles,
    headSha: '8888888888888888888888888888888888888888',
    sliceId: 'slice-audit',
    recordedAt: 8,
  });
  assert(
    auditorNonePrefixedRejected.errors.some((error) => error.includes('listing worktree blockers')),
    `auditor none-prefixed lenient fixture should reject clean-yes reports that smuggle blockers behind none: ${auditorNonePrefixedRejected.errors.join(' | ')}`,
  );
  assert(readJsonl(snapshotFiles.sliceHistoryPath).length === 2, 'rejected none-prefixed auditor fixture must not append history');

  const judged = await transcribeCanonicalRoleReport({
    role: 'completion-stop-judge',
    output: stopJudgePass,
    reportFields: parseReportFields(stopJudgePass),
    snapshotFiles,
    headSha: '5555555555555555555555555555555555555555',
    recordedAt: 5,
  });
  assert(judged.errors.length === 0, `stop-judge passing fixture should transcribe cleanly: ${judged.errors.join(' | ')}`);
  assert(judged.appended.includes('judgment:555555555555'), 'stop-judge passing fixture should append a judgment record');
  assert(readJsonl(snapshotFiles.stopHistoryPath).length === 1, 'stop-judge passing fixture should create one judgment record');

  const judgeRejected = await transcribeCanonicalRoleReport({
    role: 'completion-stop-judge',
    output: stopJudgeLenient,
    reportFields: parseReportFields(stopJudgeLenient),
    snapshotFiles,
    headSha: '6666666666666666666666666666666666666666',
    recordedAt: 6,
  });
  assert(
    judgeRejected.errors.some((error) => error.includes('remaining open top-level contract IDs')),
    `stop-judge lenient fixture should reject yes verdicts with open contracts: ${judgeRejected.errors.join(' | ')}`,
  );
  assert(
    judgeRejected.errors.some((error) => error.includes('Blocker count is greater than 0')),
    `stop-judge lenient fixture should reject yes verdicts with blockers: ${judgeRejected.errors.join(' | ')}`,
  );
  assert(readJsonl(snapshotFiles.stopHistoryPath).length === 1, 'rejected stop-judge fixture must not append judgment history');

  const judgeNonePrefixedRejected = await transcribeCanonicalRoleReport({
    role: 'completion-stop-judge',
    output: stopJudgeNonePrefixedLenient,
    reportFields: parseReportFields(stopJudgeNonePrefixedLenient),
    snapshotFiles,
    headSha: '9999999999999999999999999999999999999999',
    recordedAt: 9,
  });
  assert(
    judgeNonePrefixedRejected.errors.some((error) => error.includes('remaining open top-level contract IDs')),
    `stop-judge none-prefixed lenient fixture should reject yes verdicts with none-prefixed open contracts: ${judgeNonePrefixedRejected.errors.join(' | ')}`,
  );
  assert(readJsonl(snapshotFiles.stopHistoryPath).length === 1, 'rejected none-prefixed stop-judge fixture must not append judgment history');

  fs.rmSync(tempRoot, { recursive: true, force: true });
})().catch((error) => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
NODE

echo "evaluator calibration test passed"
