#!/usr/bin/env bash
':' //; exec node "$0" "$@"
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const REQUIRED_TRACKED_CONTRACT_FILES = [
  '.agent/README.md',
  '.agent/mission.md',
  '.agent/profile.json',
  '.agent/verify_completion_stop.sh',
  '.agent/verify_completion_control_plane.sh',
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('Failed to read ' + file + ': ' + error.message);
  }
}

function asString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function sameStringArrays(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function runGit(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!options.allowFailure && result.status !== 0) {
    const stderr = asString(result.stderr) ?? 'git command failed';
    fail(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return result;
}

function gitHeadSha() {
  const result = runGit(['rev-parse', 'HEAD'], { allowFailure: true });
  return result.status === 0 ? asString(result.stdout) : undefined;
}

function ensureTrackedContractFiles() {
  for (const file of REQUIRED_TRACKED_CONTRACT_FILES) {
    const result = runGit(['ls-files', '--error-unmatch', file], { allowFailure: true });
    if (result.status !== 0) {
      fail(`Required tracked completion contract file is missing from git index: ${file}`);
    }
  }
}

function ensureCommitExists(commitish, label) {
  const result = runGit(['rev-parse', '--verify', `${commitish}^{commit}`], { allowFailure: true });
  if (result.status !== 0) {
    fail(`${label} must resolve to an existing commit: ${commitish}`);
  }
}

function trackedDiffFiles(fromCommit, toCommit) {
  const result = runGit(['diff', '--name-only', '--diff-filter=ACMR', `${fromCommit}..${toCommit}`]);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const profile = readJson('.agent/profile.json');
const state = readJson('.agent/state.json');
const plan = readJson('.agent/plan.json');
const active = readJson('.agent/active-slice.json');
const evidence = readJson('.agent/verification-evidence.json');

ensureTrackedContractFiles();

for (const [file, record] of [
  ['.agent/profile.json', profile],
  ['.agent/state.json', state],
  ['.agent/plan.json', plan],
  ['.agent/active-slice.json', active],
]) {
  if (!asString(record.task_type)) fail(file + ' is missing task_type');
  if (!asString(record.evaluation_profile)) fail(file + ' is missing evaluation_profile');
}

const taskType = asString(profile.task_type);
const evaluationProfile = asString(profile.evaluation_profile);
if (asString(state.task_type) !== taskType) fail('.agent/state.json task_type must match .agent/profile.json task_type');
if (asString(plan.task_type) !== taskType) fail('.agent/plan.json task_type must match .agent/profile.json task_type');
if (asString(active.task_type) !== taskType) fail('.agent/active-slice.json task_type must match .agent/profile.json task_type');
if (asString(state.evaluation_profile) !== evaluationProfile) fail('.agent/state.json evaluation_profile must match .agent/profile.json evaluation_profile');
if (asString(plan.evaluation_profile) !== evaluationProfile) fail('.agent/plan.json evaluation_profile must match .agent/profile.json evaluation_profile');
if (asString(active.evaluation_profile) !== evaluationProfile) fail('.agent/active-slice.json evaluation_profile must match .agent/profile.json evaluation_profile');

if (asString(evidence.artifact_type) !== 'completion-verification-evidence') {
  fail('.agent/verification-evidence.json artifact_type must be completion-verification-evidence');
}

const exactStatuses = new Set(['selected', 'in_progress', 'committed', 'done']);
const activeStatus = asString(active.status);
const exactHandoff = exactStatuses.has(activeStatus || '');
const planSlices = Array.isArray(plan.candidate_slices) ? plan.candidate_slices : [];
const activeSliceId = asString(active.slice_id);
const planSlice = activeSliceId ? planSlices.find((slice) => asString(slice && slice.slice_id) === activeSliceId) : undefined;

if (exactHandoff && !planSlice) {
  fail('slice_id must match a slice in .agent/plan.json when status carries an exact handoff');
}

if (exactHandoff) {
  const requiredStringFields = ['goal', 'why_now', 'basis_commit'];
  for (const field of requiredStringFields) {
    if (!asString(active[field])) fail('.agent/active-slice.json is missing ' + field + ' when status carries an exact handoff');
  }
  const requiredArrayFields = ['contract_ids', 'acceptance_criteria', 'blocked_on', 'locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'remaining_contract_ids_before'];
  for (const field of requiredArrayFields) {
    if (!Array.isArray(active[field])) fail('.agent/active-slice.json is missing ' + field + ' when status carries an exact handoff');
  }
  const requiredNumberFields = ['priority', 'release_blocker_count_before', 'high_value_gap_count_before'];
  for (const field of requiredNumberFields) {
    if (asNumber(active[field]) === undefined) fail('.agent/active-slice.json is missing ' + field + ' when status carries an exact handoff');
  }

  const mismatchFields = [];
  if (asString(planSlice.slice_id) !== activeSliceId) mismatchFields.push('slice_id');
  if (asString(planSlice.goal) !== asString(active.goal)) mismatchFields.push('goal');
  if (!sameStringArrays(asStringArray(planSlice.contract_ids), asStringArray(active.contract_ids))) mismatchFields.push('contract_ids');
  if (!sameStringArrays(asStringArray(planSlice.acceptance_criteria), asStringArray(active.acceptance_criteria))) mismatchFields.push('acceptance_criteria');
  if (!sameStringArrays(asStringArray(planSlice.blocked_on), asStringArray(active.blocked_on))) mismatchFields.push('blocked_on');
  if (asNumber(planSlice.priority) !== asNumber(active.priority)) mismatchFields.push('priority');
  if (asString(planSlice.why_now) !== asString(active.why_now)) mismatchFields.push('why_now');
  const planMirrorFields = ['locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'basis_commit', 'remaining_contract_ids_before', 'release_blocker_count_before', 'high_value_gap_count_before'];
  for (const field of planMirrorFields) {
    const planValue = planSlice[field];
    const activeValue = active[field];
    if (Array.isArray(planValue) || Array.isArray(activeValue)) {
      if (!sameStringArrays(asStringArray(planValue), asStringArray(activeValue))) mismatchFields.push(field);
      continue;
    }
    if (typeof planValue === 'number' || typeof activeValue === 'number') {
      if (asNumber(planValue) !== asNumber(activeValue)) mismatchFields.push(field);
      continue;
    }
    if (asString(planValue) !== asString(activeValue)) mismatchFields.push(field);
  }
  if (mismatchFields.length > 0) {
    fail('.agent/active-slice.json must match the selected .agent/plan.json slice across: ' + mismatchFields.join(', '));
  }

  if (asString(evidence.subject_type) !== 'selected_slice') {
    fail('subject_type must be selected_slice when active slice exact handoff requires verification evidence');
  }
  if (asString(evidence.slice_id) !== activeSliceId) fail('.agent/verification-evidence.json slice_id must match .agent/active-slice.json slice_id');
  if (asString(evidence.goal) !== asString(active.goal)) fail('.agent/verification-evidence.json goal must match .agent/active-slice.json goal');
  if (!sameStringArrays(asStringArray(evidence.contract_ids), asStringArray(active.contract_ids))) fail('.agent/verification-evidence.json contract_ids must match .agent/active-slice.json contract_ids');
  if (asString(evidence.basis_commit) !== asString(active.basis_commit)) fail('.agent/verification-evidence.json basis_commit must match .agent/active-slice.json basis_commit');
  if (!sameStringArrays(asStringArray(evidence.verification_commands), asStringArray(active.verification_commands))) {
    fail('.agent/verification-evidence.json verification_commands must match .agent/active-slice.json verification_commands');
  }
  if (!asString(evidence.recorded_at)) fail('.agent/verification-evidence.json recorded_at must be present for selected-slice evidence');
  if (asString(evidence.outcome) === 'not_recorded') fail('.agent/verification-evidence.json outcome must not be not_recorded for selected-slice evidence');
  const headSha = gitHeadSha();
  if (headSha && asString(evidence.head_sha) !== headSha) {
    fail('.agent/verification-evidence.json head_sha must match current HEAD');
  }

  const basisCommit = asString(active.basis_commit);
  if (basisCommit && headSha) {
    ensureCommitExists(basisCommit, '.agent/active-slice.json basis_commit');
    const ancestorCheck = runGit(['merge-base', '--is-ancestor', basisCommit, headSha], { allowFailure: true });
    if (ancestorCheck.status !== 0) {
      fail(`.agent/active-slice.json basis_commit must be an ancestor of current HEAD: ${basisCommit} -> ${headSha}`);
    }
    const changedFiles = trackedDiffFiles(basisCommit, headSha);
    const implementationSurfaces = new Set(asStringArray(active.implementation_surfaces));
    const missingSurfaces = changedFiles.filter((file) => !implementationSurfaces.has(file));
    if (missingSurfaces.length > 0) {
      fail('.agent/active-slice.json implementation_surfaces must cover every tracked file changed from basis_commit to current HEAD; missing: ' + missingSurfaces.join(', '));
    }
  }
} else {
  const subjectType = asString(evidence.subject_type);
  if (subjectType === 'none') {
    if (asString(evidence.outcome) && asString(evidence.outcome) !== 'not_recorded') {
      fail('.agent/verification-evidence.json outcome must stay not_recorded when subject_type=none');
    }
  }
}
