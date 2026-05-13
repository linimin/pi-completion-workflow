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
    throw new Error(`${file} is missing expected legacy-cleanup ownership text: ${snippet}`);
  }
};
const assertNotIncludes = (file, snippet) => {
  const text = read(file);
  if (text.includes(snippet)) {
    throw new Error(`${file} still contains stale monolith ownership text: ${snippet}`);
  }
};

assertIncludes('extensions/completion/state-store.ts', 'export async function scaffoldCompletionFiles(');
assertIncludes('extensions/completion/state-store.ts', 'export function buildAgentReadme(');
assertIncludes('extensions/completion/state-store.ts', 'export function buildVerifyStopScript(');
assertIncludes('extensions/completion/state-store.ts', 'export function buildVerifyControlPlaneScript(');
assertIncludes('extensions/completion/state-store.ts', 'export function currentTaskType(');
assertIncludes('extensions/completion/state-store.ts', 'export function currentEvaluationProfile(');

assertIncludes('extensions/completion/status-surface.ts', 'export function nowMs(');
assertIncludes('extensions/completion/status-surface.ts', 'export function formatElapsed(');
assertIncludes('extensions/completion/status-surface.ts', 'export function createLiveRoleActivity(');
assertIncludes('extensions/completion/status-surface.ts', 'export function cloneLiveRoleActivity(');
assertIncludes('extensions/completion/status-surface.ts', 'export function applyLiveRoleEvent(');
assertIncludes('extensions/completion/status-surface.ts', 'export function pushRecentActivity(');
assertIncludes('extensions/completion/status-surface.ts', 'export function truncateInline(');

assertIncludes('extensions/completion/index.ts', 'scaffoldCompletionFiles as scaffoldCompletionFilesOnDisk');
assertIncludes('extensions/completion/index.ts', 'return await scaffoldCompletionFilesOnDisk(root, missionAnchor, {');
assertIncludes('extensions/completion/index.ts', 'applyLiveRoleEvent,');
assertIncludes('extensions/completion/index.ts', 'cloneLiveRoleActivity,');
assertIncludes('extensions/completion/index.ts', 'createLiveRoleActivity,');
assertIncludes('extensions/completion/index.ts', 'formatElapsed,');
assertIncludes('extensions/completion/index.ts', 'nowMs,');
assertIncludes('extensions/completion/index.ts', 'pushRecentActivity,');

assertNotIncludes('extensions/completion/index.ts', 'async function detectVerifierCommand(');
assertNotIncludes('extensions/completion/index.ts', 'function buildAgentReadme(');
assertNotIncludes('extensions/completion/index.ts', 'function buildMission(');
assertNotIncludes('extensions/completion/index.ts', 'function buildVerifyStopScript(');
assertNotIncludes('extensions/completion/index.ts', 'function buildVerifyControlPlaneScript(');
assertNotIncludes('extensions/completion/index.ts', 'async function ensureGitignore(');
assertNotIncludes('extensions/completion/index.ts', 'function currentTaskType(');
assertNotIncludes('extensions/completion/index.ts', 'function currentEvaluationProfile(');
assertNotIncludes('extensions/completion/index.ts', 'function formatCount(');
assertNotIncludes('extensions/completion/index.ts', 'function completionRemainingSummary(');
assertNotIncludes('extensions/completion/index.ts', 'function envNumber(');
assertNotIncludes('extensions/completion/index.ts', 'function nowMs(');
assertNotIncludes('extensions/completion/index.ts', 'type LiveActivitySignal = {');
assertNotIncludes('extensions/completion/index.ts', 'function cloneLiveRoleActivity(');
assertNotIncludes('extensions/completion/index.ts', 'function createLiveRoleActivity(');
assertNotIncludes('extensions/completion/index.ts', 'type RoleMessage = {');
assertNotIncludes('extensions/completion/index.ts', 'function applyLiveRoleEvent(');
assertNotIncludes('extensions/completion/index.ts', 'function maybeInjectTestLiveRoleActivity(');
assertNotIncludes('extensions/completion/index.ts', 'function maybeReplayTestLiveRoleEvents(');
assertNotIncludes('extensions/completion/index.ts', 'function formatElapsed(');
assertNotIncludes('extensions/completion/index.ts', 'function truncateInline(');
assertNotIncludes('extensions/completion/index.ts', 'function formatToolActivity(');
assertNotIncludes('extensions/completion/index.ts', 'function pushRecentActivity(');
assertNotIncludes('extensions/completion/index.ts', 'function parseStructuredProgress(');
assertNotIncludes('extensions/completion/index.ts', 'function lastAssistantText(');
NODE

echo "legacy cleanup test passed: $ROOT"
