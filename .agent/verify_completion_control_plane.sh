#!/usr/bin/env bash
set -euo pipefail

for file in \
  .agent/README.md \
  .agent/mission.md \
  .agent/profile.json \
  .agent/verify_completion_stop.sh \
  .agent/verify_completion_control_plane.sh \
  .agent/state.json \
  .agent/plan.json \
  .agent/active-slice.json \
  .agent/verification-evidence.json; do
  [[ -e "$file" ]] || { echo "missing required file: $file"; exit 1; }
done

node <<'NODE'
const fs = require('node:fs');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Failed to read ${file}: ${error.message}`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record, field) {
  return isRecord(record) && Object.prototype.hasOwnProperty.call(record, field);
}

function requireField(record, file, field) {
  if (!hasOwn(record, field)) fail(`${file} missing required field: ${field}`);
}

function requireFields(record, file, fields) {
  for (const field of fields) requireField(record, file, field);
}

function requireNonEmptyString(value, file, field) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${file} field ${field} must be a non-empty string`);
}

function requireFiniteNumber(value, file, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${file} field ${field} must be a finite number`);
}

function requireBoolean(value, file, field) {
  if (typeof value !== 'boolean') fail(`${file} field ${field} must be a boolean`);
}

function requireArray(value, file, field) {
  if (!Array.isArray(value)) fail(`${file} field ${field} must be an array`);
}

function requireStringArray(value, file, field, { nonEmpty = false } = {}) {
  requireArray(value, file, field);
  if (nonEmpty && value.length === 0) fail(`${file} field ${field} must be a non-empty array`);
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) fail(`${file} field ${field} must contain only non-empty strings`);
  }
}

function requireEnum(value, allowed, file, field) {
  if (!allowed.includes(value)) fail(`${file} field ${field} must be one of: ${allowed.join(', ')}`);
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

const profile = readJson('.agent/profile.json');
const state = readJson('.agent/state.json');
const plan = readJson('.agent/plan.json');
const active = readJson('.agent/active-slice.json');
const evidence = readJson('.agent/verification-evidence.json');

for (const [file, value] of [
  ['.agent/profile.json', profile],
  ['.agent/state.json', state],
  ['.agent/plan.json', plan],
  ['.agent/active-slice.json', active],
  ['.agent/verification-evidence.json', evidence],
]) {
  if (!isRecord(value)) fail(`${file} must contain a JSON object`);
}

requireFields(profile, '.agent/profile.json', [
  'schema_version',
  'protocol_id',
  'project_name',
  'required_stop_judges',
  'priority_policy_id',
  'task_type',
  'evaluation_profile',
  'docs_surfaces',
]);
requireFiniteNumber(profile.schema_version, '.agent/profile.json', 'schema_version');
requireNonEmptyString(profile.protocol_id, '.agent/profile.json', 'protocol_id');
if (profile.protocol_id !== 'completion') fail('.agent/profile.json field protocol_id must equal completion');
requireNonEmptyString(profile.project_name, '.agent/profile.json', 'project_name');
requireFiniteNumber(profile.required_stop_judges, '.agent/profile.json', 'required_stop_judges');
requireNonEmptyString(profile.priority_policy_id, '.agent/profile.json', 'priority_policy_id');
requireNonEmptyString(profile.task_type, '.agent/profile.json', 'task_type');
requireNonEmptyString(profile.evaluation_profile, '.agent/profile.json', 'evaluation_profile');
requireStringArray(profile.docs_surfaces, '.agent/profile.json', 'docs_surfaces', { nonEmpty: true });

requireFields(state, '.agent/state.json', [
  'schema_version',
  'mission_anchor',
  'task_type',
  'evaluation_profile',
  'current_phase',
  'continuation_policy',
  'continuation_reason',
  'project_done',
  'requires_reground',
  'slices_since_last_reground',
  'remaining_release_blockers',
  'remaining_high_value_gaps',
  'unsatisfied_contract_ids',
  'release_blocker_ids',
  'next_mandatory_action',
  'next_mandatory_role',
  'remaining_stop_judges',
  'last_reground_at',
  'last_auditor_verdict',
  'contract_status',
  'latest_completed_slice',
  'latest_verified_slice',
]);
requireFiniteNumber(state.schema_version, '.agent/state.json', 'schema_version');
requireNonEmptyString(state.mission_anchor, '.agent/state.json', 'mission_anchor');
requireNonEmptyString(state.task_type, '.agent/state.json', 'task_type');
requireNonEmptyString(state.evaluation_profile, '.agent/state.json', 'evaluation_profile');
requireEnum(state.current_phase, ['reground', 'implement', 'post_commit_review', 'post_commit_audit', 'post_commit_reconcile', 'stop_wave', 'awaiting_user', 'blocked', 'done'], '.agent/state.json', 'current_phase');
requireEnum(state.continuation_policy, ['continue', 'await_user_input', 'blocked', 'paused', 'done'], '.agent/state.json', 'continuation_policy');
requireNonEmptyString(state.continuation_reason, '.agent/state.json', 'continuation_reason');
requireBoolean(state.project_done, '.agent/state.json', 'project_done');
requireBoolean(state.requires_reground, '.agent/state.json', 'requires_reground');
requireFiniteNumber(state.slices_since_last_reground, '.agent/state.json', 'slices_since_last_reground');
requireArray(state.unsatisfied_contract_ids, '.agent/state.json', 'unsatisfied_contract_ids');
requireArray(state.release_blocker_ids, '.agent/state.json', 'release_blocker_ids');
if (state.next_mandatory_action !== null) requireNonEmptyString(state.next_mandatory_action, '.agent/state.json', 'next_mandatory_action');
if (state.next_mandatory_role !== null) requireEnum(state.next_mandatory_role, ['completion-bootstrapper', 'completion-regrounder', 'completion-implementer', 'completion-reviewer', 'completion-auditor', 'completion-stop-judge'], '.agent/state.json', 'next_mandatory_role');
requireFiniteNumber(state.remaining_stop_judges, '.agent/state.json', 'remaining_stop_judges');
requireNonEmptyString(state.contract_status, '.agent/state.json', 'contract_status');

requireFields(plan, '.agent/plan.json', [
  'schema_version',
  'mission_anchor',
  'task_type',
  'evaluation_profile',
  'last_reground_at',
  'plan_basis',
  'candidate_slices',
]);
requireFiniteNumber(plan.schema_version, '.agent/plan.json', 'schema_version');
requireNonEmptyString(plan.mission_anchor, '.agent/plan.json', 'mission_anchor');
requireNonEmptyString(plan.task_type, '.agent/plan.json', 'task_type');
requireNonEmptyString(plan.evaluation_profile, '.agent/plan.json', 'evaluation_profile');
requireNonEmptyString(plan.plan_basis, '.agent/plan.json', 'plan_basis');
requireArray(plan.candidate_slices, '.agent/plan.json', 'candidate_slices');

const handoffStatuses = new Set(['selected', 'in_progress', 'blocked', 'done']);
for (const [index, slice] of plan.candidate_slices.entries()) {
  const file = `.agent/plan.json candidate_slices[${index}]`;
  if (!isRecord(slice)) fail(`${file} must be an object`);
  requireFields(slice, file, [
    'slice_id',
    'goal',
    'acceptance_criteria',
    'contract_ids',
    'priority',
    'status',
    'why_now',
    'blocked_on',
    'evidence',
  ]);
  requireNonEmptyString(slice.slice_id, file, 'slice_id');
  requireNonEmptyString(slice.goal, file, 'goal');
  requireStringArray(slice.acceptance_criteria, file, 'acceptance_criteria', { nonEmpty: true });
  requireStringArray(slice.contract_ids, file, 'contract_ids', { nonEmpty: true });
  requireFiniteNumber(slice.priority, file, 'priority');
  requireEnum(slice.status, ['planned', 'selected', 'in_progress', 'blocked', 'done', 'cancelled'], file, 'status');
  requireNonEmptyString(slice.why_now, file, 'why_now');
  requireArray(slice.blocked_on, file, 'blocked_on');
  requireArray(slice.evidence, file, 'evidence');
  if (handoffStatuses.has(slice.status)) {
    requireFields(slice, file, [
      'locked_notes',
      'must_fix_findings',
      'implementation_surfaces',
      'verification_commands',
      'basis_commit',
      'remaining_contract_ids_before',
      'release_blocker_count_before',
      'high_value_gap_count_before',
    ]);
    requireArray(slice.locked_notes, file, 'locked_notes');
    requireArray(slice.must_fix_findings, file, 'must_fix_findings');
    requireStringArray(slice.implementation_surfaces, file, 'implementation_surfaces', { nonEmpty: true });
    requireStringArray(slice.verification_commands, file, 'verification_commands', { nonEmpty: true });
    requireNonEmptyString(slice.basis_commit, file, 'basis_commit');
    requireArray(slice.remaining_contract_ids_before, file, 'remaining_contract_ids_before');
    requireFiniteNumber(slice.release_blocker_count_before, file, 'release_blocker_count_before');
    requireFiniteNumber(slice.high_value_gap_count_before, file, 'high_value_gap_count_before');
  }
}

requireFields(active, '.agent/active-slice.json', [
  'schema_version',
  'mission_anchor',
  'task_type',
  'evaluation_profile',
  'status',
  'slice_id',
  'goal',
  'contract_ids',
  'acceptance_criteria',
  'priority',
  'why_now',
  'blocked_on',
  'locked_notes',
  'must_fix_findings',
  'implementation_surfaces',
  'verification_commands',
  'basis_commit',
  'remaining_contract_ids_before',
  'release_blocker_count_before',
  'high_value_gap_count_before',
]);
requireFiniteNumber(active.schema_version, '.agent/active-slice.json', 'schema_version');
requireNonEmptyString(active.mission_anchor, '.agent/active-slice.json', 'mission_anchor');
requireNonEmptyString(active.task_type, '.agent/active-slice.json', 'task_type');
requireNonEmptyString(active.evaluation_profile, '.agent/active-slice.json', 'evaluation_profile');
requireEnum(active.status, ['idle', 'selected', 'in_progress', 'committed', 'done'], '.agent/active-slice.json', 'status');
requireArray(active.contract_ids, '.agent/active-slice.json', 'contract_ids');
requireArray(active.acceptance_criteria, '.agent/active-slice.json', 'acceptance_criteria');
requireArray(active.blocked_on, '.agent/active-slice.json', 'blocked_on');
requireArray(active.locked_notes, '.agent/active-slice.json', 'locked_notes');
requireArray(active.must_fix_findings, '.agent/active-slice.json', 'must_fix_findings');
requireArray(active.implementation_surfaces, '.agent/active-slice.json', 'implementation_surfaces');
requireArray(active.verification_commands, '.agent/active-slice.json', 'verification_commands');
requireArray(active.remaining_contract_ids_before, '.agent/active-slice.json', 'remaining_contract_ids_before');
if (['selected', 'in_progress', 'committed', 'done'].includes(active.status)) {
  requireNonEmptyString(active.slice_id, '.agent/active-slice.json', 'slice_id');
  requireNonEmptyString(active.goal, '.agent/active-slice.json', 'goal');
  requireStringArray(active.contract_ids, '.agent/active-slice.json', 'contract_ids', { nonEmpty: true });
  requireStringArray(active.acceptance_criteria, '.agent/active-slice.json', 'acceptance_criteria', { nonEmpty: true });
  requireFiniteNumber(active.priority, '.agent/active-slice.json', 'priority');
  requireNonEmptyString(active.why_now, '.agent/active-slice.json', 'why_now');
  requireStringArray(active.implementation_surfaces, '.agent/active-slice.json', 'implementation_surfaces', { nonEmpty: true });
  requireStringArray(active.verification_commands, '.agent/active-slice.json', 'verification_commands', { nonEmpty: true });
  requireNonEmptyString(active.basis_commit, '.agent/active-slice.json', 'basis_commit');
  requireFiniteNumber(active.release_blocker_count_before, '.agent/active-slice.json', 'release_blocker_count_before');
  requireFiniteNumber(active.high_value_gap_count_before, '.agent/active-slice.json', 'high_value_gap_count_before');
}

requireFields(evidence, '.agent/verification-evidence.json', [
  'schema_version',
  'artifact_type',
  'subject_type',
  'slice_id',
  'goal',
  'contract_ids',
  'basis_commit',
  'head_sha',
  'verification_commands',
  'outcome',
  'recorded_at',
  'summary',
]);
requireFiniteNumber(evidence.schema_version, '.agent/verification-evidence.json', 'schema_version');
requireNonEmptyString(evidence.artifact_type, '.agent/verification-evidence.json', 'artifact_type');
requireNonEmptyString(evidence.subject_type, '.agent/verification-evidence.json', 'subject_type');
requireArray(evidence.contract_ids, '.agent/verification-evidence.json', 'contract_ids');
requireArray(evidence.verification_commands, '.agent/verification-evidence.json', 'verification_commands');
requireNonEmptyString(evidence.outcome, '.agent/verification-evidence.json', 'outcome');
requireNonEmptyString(evidence.summary, '.agent/verification-evidence.json', 'summary');

for (const [file, value] of [
  ['.agent/state.json', state.task_type],
  ['.agent/plan.json', plan.task_type],
  ['.agent/active-slice.json', active.task_type],
]) {
  if (value !== profile.task_type) fail(`${file} task_type must match .agent/profile.json task_type`);
}
for (const [file, value] of [
  ['.agent/state.json', state.evaluation_profile],
  ['.agent/plan.json', plan.evaluation_profile],
  ['.agent/active-slice.json', active.evaluation_profile],
]) {
  if (value !== profile.evaluation_profile) fail(`${file} evaluation_profile must match .agent/profile.json evaluation_profile`);
}
if (state.mission_anchor !== plan.mission_anchor || state.mission_anchor !== active.mission_anchor) {
  fail('Mission anchor mismatch across .agent/state.json, .agent/plan.json, and .agent/active-slice.json');
}

if (['selected', 'in_progress', 'committed', 'done'].includes(active.status)) {
  const selectedSlice = Array.isArray(plan.candidate_slices)
    ? plan.candidate_slices.find((slice) => isRecord(slice) && slice.slice_id === active.slice_id)
    : undefined;
  if (!selectedSlice) fail('Selected/in-progress active slice must exist in .agent/plan.json candidate_slices');
  const arrayFields = ['contract_ids', 'acceptance_criteria', 'blocked_on', 'locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'remaining_contract_ids_before'];
  const scalarFields = ['goal', 'priority', 'why_now', 'basis_commit', 'release_blocker_count_before', 'high_value_gap_count_before'];
  for (const field of arrayFields) {
    if (!arraysEqual(selectedSlice[field], active[field])) fail(`Active slice field ${field} must match the selected plan slice`);
  }
  for (const field of scalarFields) {
    if (selectedSlice[field] !== active[field]) fail(`Active slice field ${field} must match the selected plan slice`);
  }
}
NODE
