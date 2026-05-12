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
    throw new Error(`${file} is missing required role-runner extraction text: ${snippet}`);
  }
};
const assertNotIncludes = (file, snippet) => {
  const text = read(file);
  if (text.includes(snippet)) {
    throw new Error(`${file} still contains stale inline role-runner text: ${snippet}`);
  }
};

assertIncludes('extensions/completion/role-runner.ts', 'import { loadCompletionDataForReminder } from "./state-store";');
assertIncludes('extensions/completion/role-runner.ts', 'import { parseReportFields, transcribeRoleOutput, type TranscriptionResult } from "./transcription";');
assertIncludes('extensions/completion/role-runner.ts', 'const agent = await loadAgentDefinition(params.root, params.role);');
assertIncludes('extensions/completion/role-runner.ts', 'await loadCompletionDataForReminder(params.root);');
assertIncludes('extensions/completion/role-runner.ts', 'const systemPromptTemp = await writeTempFile(params.root, "pi-completion-role-", agent.systemPrompt);');
assertIncludes('extensions/completion/role-runner.ts', 'const reportFields = parseReportFields(output);');
assertIncludes('extensions/completion/role-runner.ts', 'const transcription = exitCode === 0 ? await transcribeRoleOutput(params.role, params.root, output, reportFields) : undefined;');
assertIncludes('extensions/completion/role-runner.ts', 'env: { ...process.env, PI_COMPLETION_ROLE: params.role },');
assertIncludes('extensions/completion/index.ts', 'import { getPiInvocation, runCompletionRole, writeTempFile } from "./role-runner";');
assertIncludes('extensions/completion/index.ts', 'const systemPromptTemp = await writeTempFile(runCwd, "pi-cook-proposal-analyst-", CONTEXT_PROPOSAL_ANALYST_SYSTEM_PROMPT);');
assertIncludes('extensions/completion/index.ts', 'const invocation = getPiInvocation(args);');
assertIncludes('extensions/completion/index.ts', 'const result = await runCompletionRole({');
assertNotIncludes('extensions/completion/index.ts', 'async function loadAgentDefinition(');
assertNotIncludes('extensions/completion/index.ts', 'async function writeTempFile(');
assertNotIncludes('extensions/completion/index.ts', 'function getPiInvocation(');
NODE

echo "role-runner contract test passed"
