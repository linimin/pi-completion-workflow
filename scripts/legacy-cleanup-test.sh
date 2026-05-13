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

assertIncludes('extensions/completion/proposal.ts', 'export function normalizeMissionAnchorText(');
assertIncludes('extensions/completion/proposal.ts', 'export function isWeakMissionAnchor(');
assertIncludes('extensions/completion/proposal.ts', 'export function deriveMissionAnchor(');
assertIncludes('extensions/completion/proposal.ts', 'export function assessMissionAnchor(');
assertIncludes('extensions/completion/proposal.ts', 'export function stripCodeBlocks(');
assertIncludes('extensions/completion/proposal.ts', 'export function missionAnchorsStrictlyEquivalent(');
assertIncludes('extensions/completion/proposal.ts', 'export function missionAnchorsLikelyEquivalent(');
assertIncludes('extensions/completion/proposal.ts', 'export function collectRecentDiscussionEntries(');
assertIncludes('extensions/completion/proposal.ts', 'export function serializeRecentDiscussionEntries(');
assertIncludes('extensions/completion/proposal.ts', 'export function extractJsonObjectFromText(');

assertIncludes('extensions/completion/role-runner.ts', 'export async function analyzeContextProposalWithAgent(');
assertIncludes('extensions/completion/role-runner.ts', 'class StartupAnalystOverlay extends Container');
assertIncludes('extensions/completion/role-runner.ts', 'async function runContextProposalAnalystSubprocess(');

assertIncludes('extensions/completion/prompt-surfaces.ts', 'export function buildSystemReminder(');
assertIncludes('extensions/completion/prompt-surfaces.ts', 'export function buildResumeCapsule(');

assertIncludes('extensions/completion/index.ts', 'scaffoldCompletionFiles as scaffoldCompletionFilesOnDisk');
assertIncludes('extensions/completion/index.ts', 'return await scaffoldCompletionFilesOnDisk(root, missionAnchor, {');
assertIncludes('extensions/completion/index.ts', 'applyLiveRoleEvent,');
assertIncludes('extensions/completion/index.ts', 'cloneLiveRoleActivity,');
assertIncludes('extensions/completion/index.ts', 'createLiveRoleActivity,');
assertIncludes('extensions/completion/index.ts', 'formatElapsed,');
assertIncludes('extensions/completion/index.ts', 'nowMs,');

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
assertNotIncludes('extensions/completion/index.ts', 'function normalizeMissionAnchorText(');
assertNotIncludes('extensions/completion/index.ts', 'function isWeakMissionAnchor(');
assertNotIncludes('extensions/completion/index.ts', 'function assessMissionAnchor(');
assertNotIncludes('extensions/completion/index.ts', 'function stripCodeBlocks(');
assertNotIncludes('extensions/completion/index.ts', 'function missionAnchorsStrictlyEquivalent(');
assertNotIncludes('extensions/completion/index.ts', 'function missionAnchorsLikelyEquivalent(');
assertNotIncludes('extensions/completion/index.ts', 'function collectRecentDiscussionEntries(');
assertNotIncludes('extensions/completion/index.ts', 'function serializeRecentDiscussionEntries(');
assertNotIncludes('extensions/completion/index.ts', 'function extractJsonObjectFromText(');
assertNotIncludes('extensions/completion/index.ts', 'function contextProposalAnalystModelArg(');
assertNotIncludes('extensions/completion/index.ts', 'async function runContextProposalAnalystSubprocess(');
assertNotIncludes('extensions/completion/index.ts', 'async function analyzeContextProposalWithAgent(');
assertNotIncludes('extensions/completion/index.ts', 'function deriveMissionAnchor(');
assertNotIncludes('extensions/completion/index.ts', 'function buildSystemReminder(');
assertNotIncludes('extensions/completion/index.ts', 'function buildResumeCapsule(');
NODE

echo "legacy cleanup test passed: $ROOT"
