# completion

`completion` is a repo-local control-plane protocol for long-running software-project completion work.

## Tracked Repo-Contract Files

- `.agent/README.md`
- `.agent/mission.md`
- `.agent/profile.json`
- `.agent/verify_completion_stop.sh`
- `.agent/verify_completion_control_plane.sh`

## Ignored Canonical Execution State

- `.agent/state.json`
- `.agent/plan.json`
- `.agent/active-slice.json`
- `.agent/slice-history.jsonl`
- `.agent/stop-check-history.jsonl`
- `.agent/*.log`

## Scratch Space

- Use repo-local `.agent/tmp/` as the default temporary workspace for completion.
- Keep `.agent/tmp/` ignored in `.gitignore` alongside other non-contract `.agent/*` execution artifacts.
- Do not write scratch artifacts to `/tmp` or `/private/tmp` by default.
- If a tool explicitly requires OS temp, prefer a scoped path such as `$TMPDIR/pi-completion/<repo-name>/` and treat it as disposable.
- Do not store canonical state, required verification evidence, or the only copy of a deliverable exclusively in scratch paths.

## Fixed Profile Schema

```json
{
  "schema_version": 1,
  "protocol_id": "completion",
  "project_name": "<repo-name>",
  "required_stop_judges": 3,
  "priority_policy_id": "completion-default",
  "docs_surfaces": ["README.md", "docs/"]
}
```

## Fixed State Model

`state.json` carries the current authoritative summary.

Required fields:

- `schema_version`
- `mission_anchor`
- `current_phase`
- `continuation_policy`
- `continuation_reason`
- `project_done`
- `requires_reground`
- `slices_since_last_reground`
- `remaining_release_blockers`
- `remaining_high_value_gaps`
- `unsatisfied_contract_ids`
- `release_blocker_ids`
- `next_mandatory_action`
- `next_mandatory_role`
- `remaining_stop_judges`
- `last_reground_at`
- `last_auditor_verdict`
- `contract_status`
- `latest_completed_slice`
- `latest_verified_slice`

`continuation_policy` must be one of:

- `continue`
- `await_user_input`
- `blocked`
- `paused`
- `done`

`next_mandatory_role` must be one of:

- `completion-bootstrapper`
- `completion-regrounder`
- `completion-implementer`
- `completion-reviewer`
- `completion-auditor`
- `completion-stop-judge`
- `null`

`current_phase` must be one of:

- `reground`
- `implement`
- `post_commit_review`
- `post_commit_audit`
- `post_commit_reconcile`
- `stop_wave`
- `awaiting_user`
- `blocked`
- `done`

Rules:

1. `continuation_policy == continue` means the workflow root must keep advancing and must not stop after a slice to ask whether to continue.
2. `continuation_policy == await_user_input` means the workflow root must ask only for the exact missing input and then stop.
3. `continuation_policy == blocked` means the workflow root must report the blocker and stop.
4. `continuation_policy == paused` means the user explicitly paused the workflow.
5. `continuation_policy == done` means canonical final stop reconciliation is complete and the workflow may stop.

`plan.json` carries the ordered persistent slice backlog.

Required fields:

- `schema_version`
- `mission_anchor`
- `last_reground_at`
- `plan_basis`
- `candidate_slices`

Each `candidate_slices[]` entry must include:

- `slice_id`
- `goal`
- `acceptance_criteria`
- `contract_ids`
- `priority`
- `status` where status is one of `planned`, `selected`, `in_progress`, `blocked`, `done`, `cancelled`
- `why_now`
- `blocked_on`
- `evidence`

### Acceptance Criteria Contract

`acceptance_criteria` is a non-empty list of concrete, verifiable conditions that define when a slice is done.

Rules:

1. Set at re-ground time. Every slice in `candidate_slices` must have `acceptance_criteria` populated during the re-ground wave that first introduces or re-evaluates it. A slice with empty `acceptance_criteria` is invalid.
2. Immutable after lock. Once a slice's `acceptance_criteria` are set, subsequent re-ground waves must not weaken, replace, or silently drop criteria. The only allowed mutations are:
   - removing a criterion because repo truth already satisfies it, with `evidence` updated to prove it
   - adding a criterion discovered during implementation that was missing from the original assessment
3. Done requires all satisfied. A slice may only transition to `done` when every acceptance criterion is satisfied and `evidence` contains the proof for each one.
4. Re-ground validation. During re-ground, the current slice backlog must be revalidated against repo truth. A slice previously marked `done` whose criteria no longer hold must be reopened.
5. Clean handoff before next slice. After a committed slice is reviewed and audited, the tracked and unignored worktree must be clean before the next slice is selected.

`active-slice.json` carries one current slice cursor.

When `status` is `selected`, `in_progress`, `committed`, or `done`, `active-slice.json` must also carry the exact implementer handoff snapshot so `completion-implementer` can resume after compaction without asking the user to resend the original caller payload.

Required exact handoff fields:

- `acceptance_criteria`
- `priority`
- `why_now`
- `blocked_on`
- `locked_notes`
- `must_fix_findings`
- `basis_commit`
- `remaining_contract_ids_before`
- `release_blocker_count_before`
- `high_value_gap_count_before`

Allowed `status` values:

- `idle`
- `selected`
- `in_progress`
- `committed`
- `done`

`slice-history.jsonl` is append-only and only accepts:

- `implemented`
- `reviewed`
- `audited`
- `accepted`
- `reopened`

Minimum record shape:

- `schema_version`
- `type`
- `recorded_at`
- `slice_id`
- `commit_sha`
- `head_sha`

`stop-check-history.jsonl` is append-only and only accepts:

- `judgment`

Minimum record shape:

- `schema_version`
- `type`
- `recorded_at`
- `head_sha`
- `can_stop`
- `blocker_count`
- `high_value_gap_count`

Empty history files are legal.

## Structured Evaluation Rubric Foundation

`completion-reviewer`, `completion-auditor`, and `completion-stop-judge` must emit rubric-backed evaluations using the same shared dimension names and verdict semantics.

This foundation is a prompt/report contract only. It does **not** add canonical `task_type` or `evaluation_profile` schema yet; later slices may wire those through the control plane.

Required rubric section:

- `Rubric:`
- `- Contract coverage: pass|concern|fail - ...`
- `- Correctness risk: pass|concern|fail - ...`
- `- Verification evidence: pass|concern|fail - ...`
- `- Docs/state parity: pass|concern|fail - ...`

Use the dimension names and verdict words exactly as written above.

Dimension meaning:

- `Contract coverage` — whether the slice or current HEAD satisfies the locked acceptance criteria and role-specific workflow obligations.
- `Correctness risk` — whether regressions, blocking defects, safety issues, or closure risks are still evident in current repo truth.
- `Verification evidence` — whether tests, deterministic proof, and rerun verification are strong enough for the role's decision.
- `Docs/state parity` — whether docs, config, runbooks, and canonical `.agent` state stay truthful to shipped behavior for the role's scope.

Verdict semantics:

- `pass` — no material issue remains for that dimension in the role's current decision.
- `concern` — a real caveat or remaining gap exists, but it does not by itself force rejection or `NO-STOP`; explain the follow-up plainly.
- `fail` — a blocking issue or contradictory truth exists and the role's final verdict must not be positive.

Decision alignment rules:

- Reviewer: any `fail` means `Acceptable as-is` must be `no`.
- Auditor: use `concern` or `fail` to explain why the project is not yet done and whether canonical backlog/state remain truthful.
- Stop judge: any `fail` means `Can the project stop now` must be `no`.

Always include all four rubric lines, even when every dimension is `pass`.

## One-Slice Lifecycle

1. Re-ground from current repo truth.
2. Choose exactly one highest-value slice.
3. Mark that slice in canonical state.
4. Implement the smallest correct tracked-file change.
5. Add tests or deterministic proof that satisfy one or more `acceptance_criteria`.
6. Run focused verification first, then broader verification if needed.
7. Commit.
8. Update canonical state and append one `implemented` record.
9. Run read-only review and audit.
10. Confirm the tracked and unignored worktree is clean before selecting the next slice.
11. Append `reviewed`, `audited`, and `accepted` or `reopened`.
12. Repeat until the stop wave concludes the repo may stop.

## Workflow Topology

The workflow topology is mandatory and flat:

1. The main pi session stays the workflow root.
2. The main pi session invokes at most one completion role at a time.
3. `completion-bootstrapper` is used only for first-time setup or missing tracked contract-file repair.
4. `completion-regrounder` is the mandatory role for canonical `.agent` reconciliation, slice selection, post-review or post-audit reconciliation, and final stop reconciliation.
5. `completion-implementer`, `completion-reviewer`, `completion-auditor`, and `completion-stop-judge` are sibling roles invoked directly by the workflow root.
6. No completion role may invoke another completion role during the normal workflow.

## Primary Workflow Driver Contract

The main pi session may:

- read repo truth and canonical `.agent` state
- update canonical `.agent/**` state truthfully for handoff
- invoke the correct completion role according to the mandatory dispatch table
- append canonical history records as a faithful transcription of actual role outputs

It must not, while a slice is selected or in progress:

- directly edit non-`.agent/**` tracked product/docs/config/test files for that slice
- directly create the slice commit
- directly claim review/audit/acceptance/judgment outcomes without the corresponding role output
- bypass mandatory completion-role dispatch for convenience
- hand control back to the user between slices merely to ask whether to continue when `continuation_policy == continue`

## Mandatory Dispatch Table

1. If tracked protocol contract files are missing or first-time onboarding is required, invoke `completion-bootstrapper`.
2. If canonical `.agent` execution state is missing, stale, invalid, contradictory, or ambiguous after compaction or recovery, invoke `completion-regrounder` first.
3. If no slice is selected, invoke `completion-regrounder` to reconcile `.agent/plan.json` and return the next exact handoff payload.
4. If a slice is `selected` or `in_progress` and no new commit exists for it yet, invoke `completion-implementer`.
5. If the latest committed slice lacks review, invoke `completion-reviewer`.
6. If the latest committed slice lacks audit, invoke `completion-auditor`.
7. If canonical reconciliation is needed after review or audit, invoke `completion-regrounder`.
8. If all slices are done and final closure is under evaluation, invoke the required `completion-stop-judge` sessions directly.
9. After the required judgments are recorded, rerun `bash .agent/verify_completion_stop.sh` and invoke `completion-regrounder` for final stop reconciliation.

## Compaction And Recovery

After context compaction, suspected memory loss, stalled-role recovery, or any ambiguous completion state, the workflow root must re-read:

- `.agent/state.json`
- `.agent/plan.json`
- `.agent/active-slice.json`

The workflow root must invoke `completion-regrounder` before continuing whenever any of the following is true:

- `requires_reground` is `true`
- `requires_reground` is unknown because canonical state is missing or unreadable
- `next_mandatory_action` is missing, unknown, or ambiguous
- `active-slice.json` does not match `.agent/plan.json`
- acceptance criteria for the selected or active slice are missing or unclear
- the exact implementer handoff snapshot in `.agent/active-slice.json` is missing, stale, or contradictory

The workflow root must not continue implementation, review, audit, or stop evaluation from compacted conversation memory alone.

## Default Priority Policy

`completion-default` ranks candidate slices in this order:

1. shipped behavior versus docs/config mismatch
2. safety, security, data-loss, fail-open, or fail-closed critical behavior
3. startup, install, migration, or restart critical path
4. operator emergency, rollback, or recovery path
5. normal primary lifecycle path
6. docs/config/runbook parity
7. regression depth
8. final closure and hygiene
