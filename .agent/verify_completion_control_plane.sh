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
  .agent/active-slice.json; do
  [[ -e "$file" ]] || { echo "missing required file: $file"; exit 1; }
done

node <<'NODE'
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

for (const file of ['.agent/profile.json', '.agent/state.json', '.agent/plan.json', '.agent/active-slice.json']) {
  readJson(file);
}

const profile = readJson('.agent/profile.json');
const state = readJson('.agent/state.json');
const plan = readJson('.agent/plan.json');
const active = readJson('.agent/active-slice.json');

assert(isObject(profile), '.agent/profile.json must be an object');
assert(isObject(state), '.agent/state.json must be an object');
assert(isObject(plan), '.agent/plan.json must be an object');
assert(isObject(active), '.agent/active-slice.json must be an object');

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
  hasOnlyKeys(slice, requiredSlice, label);
  assert(isString(slice.slice_id) && slice.slice_id.length > 0, label + ': slice_id must be a non-empty string');
  assert(isString(slice.goal) && slice.goal.length > 0, label + ': goal must be a non-empty string');
  assert(Array.isArray(slice.acceptance_criteria) && slice.acceptance_criteria.length > 0 && slice.acceptance_criteria.every((item) => typeof item === 'string' && item.length > 0), label + ': acceptance_criteria must be a non-empty array of strings');
  assert(isStringArray(slice.contract_ids), label + ': contract_ids must be an array of strings');
  assert(typeof slice.priority === 'number' && Number.isFinite(slice.priority), label + ': priority must be a finite number');
  assert(sliceStatuses.includes(slice.status), label + ': invalid status');
  assert(isString(slice.why_now) && slice.why_now.length > 0, label + ': why_now must be a non-empty string');
  assert(isStringArray(slice.blocked_on), label + ': blocked_on must be an array of strings');
  assert(isStringArray(slice.evidence), label + ': evidence must be an array of strings');
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
} else {
  assert(active.priority === null || active.priority === undefined || (typeof active.priority === 'number' && Number.isFinite(active.priority)), '.agent/active-slice.json: idle priority must be null/undefined or a finite number');
  assert(active.why_now === null || active.why_now === undefined || typeof active.why_now === 'string', '.agent/active-slice.json: idle why_now must be null/undefined or a string');
}
NODE
