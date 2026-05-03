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
const childProcess = require('node:child_process');
const fs = require('node:fs');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const assert = (condition, message) => {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string';
const isNonEmptyString = (value) => isString(value) && value.length > 0;
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const hasOnlyKeys = (object, allowed, label) => {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  assert(unknown.length === 0, label + ': unknown keys: ' + unknown.join(', '));
};
const requireKeys = (object, required, label) => {
  for (const key of required) {
    assert(Object.prototype.hasOwnProperty.call(object, key), label + ': missing required field: ' + key);
  }
};
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sameStringArrays = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);

for (const file of ['.agent/profile.json', '.agent/state.json', '.agent/plan.json', '.agent/active-slice.json', '.agent/verification-evidence.json']) {
  readJson(file);
}

const profile = readJson('.agent/profile.json');
const state = readJson('.agent/state.json');
const plan = readJson('.agent/plan.json');
const active = readJson('.agent/active-slice.json');
const evidence = readJson('.agent/verification-evidence.json');

assert(isObject(profile), '.agent/profile.json must be an object');
assert(isObject(state), '.agent/state.json must be an object');
assert(isObject(plan), '.agent/plan.json must be an object');
assert(isObject(active), '.agent/active-slice.json must be an object');
assert(isObject(evidence), '.agent/verification-evidence.json must be an object');

const requiredProfile = ['schema_version', 'protocol_id', 'project_name', 'required_stop_judges', 'priority_policy_id', 'task_type', 'evaluation_profile', 'docs_surfaces'];
requireKeys(profile, requiredProfile, '.agent/profile.json');
hasOnlyKeys(profile, requiredProfile, '.agent/profile.json');
assert(profile.protocol_id === 'completion', '.agent/profile.json: protocol_id must be completion');
assert(Array.isArray(profile.docs_surfaces), '.agent/profile.json: docs_surfaces must be an array');
assert(isNonEmptyString(profile.task_type), '.agent/profile.json: task_type must be a non-empty string');
assert(isNonEmptyString(profile.evaluation_profile), '.agent/profile.json: evaluation_profile must be a non-empty string');

const requiredState = [
  'schema_version','mission_anchor','task_type','evaluation_profile','current_phase','continuation_policy','continuation_reason','project_done',
  'requires_reground','slices_since_last_reground','remaining_release_blockers','remaining_high_value_gaps',
  'unsatisfied_contract_ids','release_blocker_ids','next_mandatory_action','next_mandatory_role',
  'remaining_stop_judges','last_reground_at','last_auditor_verdict','contract_status','latest_completed_slice','latest_verified_slice'
];
const continuationPolicies = ['continue', 'await_user_input', 'blocked', 'paused', 'done'];
const workflowRoles = ['completion-bootstrapper', 'completion-regrounder', 'completion-implementer', 'completion-reviewer', 'completion-auditor', 'completion-stop-judge', null];
const workflowPhases = ['reground', 'implement', 'post_commit_review', 'post_commit_audit', 'post_commit_reconcile', 'stop_wave', 'awaiting_user', 'blocked', 'done'];
requireKeys(state, requiredState, '.agent/state.json');
hasOnlyKeys(state, requiredState, '.agent/state.json');
assert(continuationPolicies.includes(state.continuation_policy), '.agent/state.json: invalid continuation_policy');
assert(workflowRoles.includes(state.next_mandatory_role), '.agent/state.json: invalid next_mandatory_role');
assert(workflowPhases.includes(state.current_phase), '.agent/state.json: invalid current_phase');
assert(isNonEmptyString(state.task_type), '.agent/state.json: task_type must be a non-empty string');
assert(isNonEmptyString(state.evaluation_profile), '.agent/state.json: evaluation_profile must be a non-empty string');
assert(isStringArray(state.unsatisfied_contract_ids), '.agent/state.json: unsatisfied_contract_ids must be an array of strings');
assert(isStringArray(state.release_blocker_ids), '.agent/state.json: release_blocker_ids must be an array of strings');

const requiredPlan = ['schema_version', 'mission_anchor', 'task_type', 'evaluation_profile', 'last_reground_at', 'plan_basis', 'candidate_slices'];
const requiredSlice = ['slice_id', 'goal', 'acceptance_criteria', 'contract_ids', 'priority', 'status', 'why_now', 'blocked_on', 'evidence'];
const planMirrorFields = ['locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'basis_commit', 'remaining_contract_ids_before', 'release_blocker_count_before', 'high_value_gap_count_before'];
const allowedSlice = [...requiredSlice, ...planMirrorFields];
const sliceStatuses = ['planned', 'selected', 'in_progress', 'blocked', 'done', 'cancelled'];
requireKeys(plan, requiredPlan, '.agent/plan.json');
hasOnlyKeys(plan, requiredPlan, '.agent/plan.json');
assert(isNonEmptyString(plan.task_type), '.agent/plan.json: task_type must be a non-empty string');
assert(isNonEmptyString(plan.evaluation_profile), '.agent/plan.json: evaluation_profile must be a non-empty string');
assert(Array.isArray(plan.candidate_slices), '.agent/plan.json: candidate_slices must be an array');
for (const [index, slice] of plan.candidate_slices.entries()) {
  const label = '.agent/plan.json candidate_slices[' + index + ']';
  assert(isObject(slice), label + ' must be an object');
  requireKeys(slice, requiredSlice, label);
  hasOnlyKeys(slice, allowedSlice, label);
  assert(isString(slice.slice_id) && slice.slice_id.length > 0, label + ': slice_id must be a non-empty string');
  assert(isString(slice.goal) && slice.goal.length > 0, label + ': goal must be a non-empty string');
  assert(Array.isArray(slice.acceptance_criteria) && slice.acceptance_criteria.length > 0 && slice.acceptance_criteria.every((item) => typeof item === 'string' && item.length > 0), label + ': acceptance_criteria must be a non-empty array of strings');
  assert(isStringArray(slice.contract_ids), label + ': contract_ids must be an array of strings');
  assert(typeof slice.priority === 'number' && Number.isFinite(slice.priority), label + ': priority must be a finite number');
  assert(sliceStatuses.includes(slice.status), label + ': invalid status');
  assert(isString(slice.why_now) && slice.why_now.length > 0, label + ': why_now must be a non-empty string');
  assert(isStringArray(slice.blocked_on), label + ': blocked_on must be an array of strings');
  assert(isStringArray(slice.evidence), label + ': evidence must be an array of strings');
  if (hasOwn(slice, 'locked_notes')) assert(isStringArray(slice.locked_notes), label + ': locked_notes must be an array of strings when present');
  if (hasOwn(slice, 'must_fix_findings')) assert(isStringArray(slice.must_fix_findings), label + ': must_fix_findings must be an array of strings when present');
  if (hasOwn(slice, 'implementation_surfaces')) assert(isStringArray(slice.implementation_surfaces), label + ': implementation_surfaces must be an array of strings when present');
  if (hasOwn(slice, 'verification_commands')) assert(isStringArray(slice.verification_commands), label + ': verification_commands must be an array of strings when present');
  if (hasOwn(slice, 'basis_commit')) assert(isNonEmptyString(slice.basis_commit), label + ': basis_commit must be a non-empty string when present');
  if (hasOwn(slice, 'remaining_contract_ids_before')) assert(isStringArray(slice.remaining_contract_ids_before), label + ': remaining_contract_ids_before must be an array of strings when present');
  if (hasOwn(slice, 'release_blocker_count_before')) assert(typeof slice.release_blocker_count_before === 'number' && Number.isFinite(slice.release_blocker_count_before), label + ': release_blocker_count_before must be a finite number when present');
  if (hasOwn(slice, 'high_value_gap_count_before')) assert(typeof slice.high_value_gap_count_before === 'number' && Number.isFinite(slice.high_value_gap_count_before), label + ': high_value_gap_count_before must be a finite number when present');
}

const isNonEmptyStringArray = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => isNonEmptyString(item));
const requiredActiveBase = ['schema_version', 'mission_anchor', 'task_type', 'evaluation_profile', 'status', 'slice_id', 'goal', 'contract_ids', 'acceptance_criteria', 'blocked_on', 'locked_notes', 'must_fix_findings', 'implementation_surfaces', 'verification_commands', 'basis_commit', 'remaining_contract_ids_before', 'release_blocker_count_before', 'high_value_gap_count_before'];
const allowedActive = [...requiredActiveBase, 'priority', 'why_now'];
const activeStatuses = ['idle', 'selected', 'in_progress', 'committed', 'done'];
requireKeys(active, requiredActiveBase, '.agent/active-slice.json');
hasOnlyKeys(active, allowedActive, '.agent/active-slice.json');
assert(activeStatuses.includes(active.status), '.agent/active-slice.json: invalid status');
assert(isNonEmptyString(active.task_type), '.agent/active-slice.json: task_type must be a non-empty string');
assert(isNonEmptyString(active.evaluation_profile), '.agent/active-slice.json: evaluation_profile must be a non-empty string');
assert(isStringArray(active.contract_ids), '.agent/active-slice.json: contract_ids must be an array of strings');
assert(Array.isArray(active.acceptance_criteria), '.agent/active-slice.json: acceptance_criteria must be an array');
assert(isStringArray(active.blocked_on), '.agent/active-slice.json: blocked_on must be an array of strings');
assert(isStringArray(active.locked_notes), '.agent/active-slice.json: locked_notes must be an array of strings');
assert(isStringArray(active.must_fix_findings), '.agent/active-slice.json: must_fix_findings must be an array of strings');
assert(isStringArray(active.implementation_surfaces), '.agent/active-slice.json: implementation_surfaces must be an array of strings');
assert(isStringArray(active.verification_commands), '.agent/active-slice.json: verification_commands must be an array of strings');
assert(isStringArray(active.remaining_contract_ids_before), '.agent/active-slice.json: remaining_contract_ids_before must be an array of strings');

const requiredEvidence = ['schema_version', 'artifact_type', 'subject_type', 'slice_id', 'goal', 'contract_ids', 'basis_commit', 'head_sha', 'verification_commands', 'outcome', 'recorded_at', 'summary'];
const evidenceSubjectTypes = ['none', 'selected_slice', 'current_head'];
const evidenceOutcomes = ['not_recorded', 'passed', 'failed'];
requireKeys(evidence, requiredEvidence, '.agent/verification-evidence.json');
hasOnlyKeys(evidence, requiredEvidence, '.agent/verification-evidence.json');
assert(evidence.artifact_type === 'completion-verification-evidence', '.agent/verification-evidence.json: artifact_type must be completion-verification-evidence');
assert(evidenceSubjectTypes.includes(evidence.subject_type), '.agent/verification-evidence.json: invalid subject_type');
assert(evidence.slice_id === null || isNonEmptyString(evidence.slice_id), '.agent/verification-evidence.json: slice_id must be null or a non-empty string');
assert(evidence.goal === null || isNonEmptyString(evidence.goal), '.agent/verification-evidence.json: goal must be null or a non-empty string');
assert(isStringArray(evidence.contract_ids), '.agent/verification-evidence.json: contract_ids must be an array of strings');
assert(evidence.basis_commit === null || isNonEmptyString(evidence.basis_commit), '.agent/verification-evidence.json: basis_commit must be null or a non-empty string');
assert(evidence.head_sha === null || isNonEmptyString(evidence.head_sha), '.agent/verification-evidence.json: head_sha must be null or a non-empty string');
assert(isStringArray(evidence.verification_commands), '.agent/verification-evidence.json: verification_commands must be an array of strings');
assert(evidenceOutcomes.includes(evidence.outcome), '.agent/verification-evidence.json: invalid outcome');
assert(evidence.recorded_at === null || (isNonEmptyString(evidence.recorded_at) && !Number.isNaN(Date.parse(evidence.recorded_at))), '.agent/verification-evidence.json: recorded_at must be null or an ISO-8601 string');
assert(isNonEmptyString(evidence.summary), '.agent/verification-evidence.json: summary must be a non-empty string');

assert(state.task_type === profile.task_type, '.agent/state.json: task_type must match .agent/profile.json');
assert(plan.task_type === profile.task_type, '.agent/plan.json: task_type must match .agent/profile.json');
assert(active.task_type === profile.task_type, '.agent/active-slice.json: task_type must match .agent/profile.json');
assert(state.evaluation_profile === profile.evaluation_profile, '.agent/state.json: evaluation_profile must match .agent/profile.json');
assert(plan.evaluation_profile === profile.evaluation_profile, '.agent/plan.json: evaluation_profile must match .agent/profile.json');
assert(active.evaluation_profile === profile.evaluation_profile, '.agent/active-slice.json: evaluation_profile must match .agent/profile.json');

const requiresExactHandoff = ['selected', 'in_progress', 'committed', 'done'].includes(active.status);
if (requiresExactHandoff) {
  assert(isNonEmptyStringArray(active.acceptance_criteria), '.agent/active-slice.json: acceptance_criteria must be a non-empty array of strings when status carries an exact handoff');
  assert(typeof active.priority === 'number' && Number.isFinite(active.priority), '.agent/active-slice.json: priority must be a finite number when status carries an exact handoff');
  assert(isString(active.why_now) && active.why_now.length > 0, '.agent/active-slice.json: why_now must be a non-empty string when status carries an exact handoff');
  assert(isNonEmptyStringArray(active.implementation_surfaces), '.agent/active-slice.json: implementation_surfaces must be a non-empty array of strings when status carries an exact handoff');
  assert(isNonEmptyStringArray(active.verification_commands), '.agent/active-slice.json: verification_commands must be a non-empty array of strings when status carries an exact handoff');
  assert(isString(active.basis_commit) && active.basis_commit.length > 0, '.agent/active-slice.json: basis_commit must be a non-empty string when status carries an exact handoff');
  assert(typeof active.release_blocker_count_before === 'number' && Number.isFinite(active.release_blocker_count_before), '.agent/active-slice.json: release_blocker_count_before must be a finite number when status carries an exact handoff');
  assert(typeof active.high_value_gap_count_before === 'number' && Number.isFinite(active.high_value_gap_count_before), '.agent/active-slice.json: high_value_gap_count_before must be a finite number when status carries an exact handoff');

  const planSlice = plan.candidate_slices.find((slice) => isObject(slice) && slice.slice_id === active.slice_id);
  assert(isObject(planSlice), '.agent/active-slice.json: slice_id must match a slice in .agent/plan.json when status carries an exact handoff');
  const drift = [];
  if (planSlice.goal !== active.goal) drift.push('goal');
  if (!sameStringArrays(planSlice.contract_ids, active.contract_ids)) drift.push('contract_ids');
  if (!sameStringArrays(planSlice.acceptance_criteria, active.acceptance_criteria)) drift.push('acceptance_criteria');
  if (!sameStringArrays(planSlice.blocked_on, active.blocked_on)) drift.push('blocked_on');
  if (planSlice.priority !== active.priority) drift.push('priority');
  if (planSlice.why_now !== active.why_now) drift.push('why_now');

  const expectPlanArrayMirror = (field) => {
    if (!hasOwn(planSlice, field) || !sameStringArrays(planSlice[field], active[field])) drift.push(field);
  };
  const expectPlanStringMirror = (field) => {
    if (!hasOwn(planSlice, field) || planSlice[field] !== active[field]) drift.push(field);
  };
  const expectPlanNumberMirror = (field) => {
    if (!hasOwn(planSlice, field) || planSlice[field] !== active[field]) drift.push(field);
  };

  expectPlanArrayMirror('implementation_surfaces');
  expectPlanArrayMirror('verification_commands');
  expectPlanArrayMirror('locked_notes');
  expectPlanArrayMirror('must_fix_findings');
  expectPlanStringMirror('basis_commit');
  expectPlanArrayMirror('remaining_contract_ids_before');
  expectPlanNumberMirror('release_blocker_count_before');
  expectPlanNumberMirror('high_value_gap_count_before');
  assert(drift.length === 0, '.agent/active-slice.json must match the selected .agent/plan.json slice across: ' + Array.from(new Set(drift)).join(', '));
}

const currentHead = (() => {
  try {
    return childProcess.execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
})();

if (requiresExactHandoff) {
  assert(evidence.subject_type === 'selected_slice', '.agent/verification-evidence.json: subject_type must be selected_slice when active slice exact handoff requires verification evidence');
  assert(evidence.slice_id === active.slice_id, '.agent/verification-evidence.json: slice_id must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(evidence.goal === active.goal, '.agent/verification-evidence.json: goal must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(sameStringArrays(evidence.contract_ids, active.contract_ids), '.agent/verification-evidence.json: contract_ids must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(evidence.basis_commit === active.basis_commit, '.agent/verification-evidence.json: basis_commit must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(sameStringArrays(evidence.verification_commands, active.verification_commands), '.agent/verification-evidence.json: verification_commands must match .agent/active-slice.json when active slice exact handoff requires verification evidence');
  assert(evidence.outcome === 'passed', '.agent/verification-evidence.json: outcome must be passed when active slice exact handoff requires verification evidence');
  assert(isNonEmptyString(evidence.recorded_at) && !Number.isNaN(Date.parse(evidence.recorded_at)), '.agent/verification-evidence.json: recorded_at must be an ISO-8601 string when active slice exact handoff requires verification evidence');
  if (currentHead) assert(evidence.head_sha === currentHead, '.agent/verification-evidence.json: head_sha must match current git HEAD when active slice exact handoff requires verification evidence');
} else if (evidence.subject_type === 'none') {
  assert(evidence.slice_id === null, '.agent/verification-evidence.json: slice_id must be null when subject_type is none');
  assert(evidence.goal === null, '.agent/verification-evidence.json: goal must be null when subject_type is none');
  assert(evidence.contract_ids.length === 0, '.agent/verification-evidence.json: contract_ids must be empty when subject_type is none');
  assert(evidence.basis_commit === null, '.agent/verification-evidence.json: basis_commit must be null when subject_type is none');
  assert(evidence.head_sha === null, '.agent/verification-evidence.json: head_sha must be null when subject_type is none');
  assert(evidence.verification_commands.length === 0, '.agent/verification-evidence.json: verification_commands must be empty when subject_type is none');
  assert(evidence.outcome === 'not_recorded', '.agent/verification-evidence.json: outcome must be not_recorded when subject_type is none');
  assert(evidence.recorded_at === null, '.agent/verification-evidence.json: recorded_at must be null when subject_type is none');
} else {
  assert(evidence.outcome === 'passed', '.agent/verification-evidence.json: outcome must be passed when verification evidence is recorded');
  assert(isNonEmptyStringArray(evidence.verification_commands), '.agent/verification-evidence.json: verification_commands must be a non-empty array when verification evidence is recorded');
  assert(isNonEmptyString(evidence.recorded_at) && !Number.isNaN(Date.parse(evidence.recorded_at)), '.agent/verification-evidence.json: recorded_at must be an ISO-8601 string when verification evidence is recorded');
  if (currentHead) assert(evidence.head_sha === currentHead, '.agent/verification-evidence.json: head_sha must match current git HEAD when verification evidence is recorded');
  if (evidence.subject_type === 'selected_slice') {
    assert(isNonEmptyString(evidence.slice_id), '.agent/verification-evidence.json: slice_id must be a non-empty string when subject_type is selected_slice');
    assert(isNonEmptyString(evidence.goal), '.agent/verification-evidence.json: goal must be a non-empty string when subject_type is selected_slice');
    assert(isNonEmptyString(evidence.basis_commit), '.agent/verification-evidence.json: basis_commit must be a non-empty string when subject_type is selected_slice');
  } else {
    assert(evidence.subject_type === 'current_head', '.agent/verification-evidence.json: only current_head or selected_slice may carry recorded verification evidence');
  }
}

if (!requiresExactHandoff) {
  assert(active.priority === null || active.priority === undefined || (typeof active.priority === 'number' && Number.isFinite(active.priority)), '.agent/active-slice.json: idle priority must be null/undefined or a finite number');
  assert(active.why_now === null || active.why_now === undefined || typeof active.why_now === 'string', '.agent/active-slice.json: idle why_now must be null/undefined or a string');
}
NODE
