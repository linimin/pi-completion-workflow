---
name: completion-protocol
description: Shared completion workflow protocol for long-running coding tasks with canonical .agent state, one-slice execution, mandatory role dispatch, recovery, and final stop criteria. Use when driving persistent end-to-end completion work across multiple sessions.
---

# Completion Protocol

Load this skill whenever you are operating inside the `completion` workflow.

This skill defines shared protocol facts only. Role-specific behavior belongs in the dedicated completion agents:

- `completion-bootstrapper`
- `completion-regrounder`
- `completion-implementer`
- `completion-reviewer`
- `completion-auditor`
- `completion-stop-judge`

## Shared Rules

- Current repo truth beats stale notes, stale summaries, and conversation memory.
- `plan.json` is the persistent machine-readable slice backlog. Rebuild it during every re-grounding wave and keep it truthful after every committed slice.
- `state.json` is the persistent machine-readable workflow controller. Keep `current_phase`, `continuation_policy`, `continuation_reason`, `next_mandatory_role`, and `next_mandatory_action` truthful after every transition.
- Every slice in `plan.json` must have non-empty `acceptance_criteria` — concrete, verifiable conditions that define done. A slice without acceptance criteria is invalid and must not be selected.
- Acceptance criteria are immutable after lock except for removing a criterion already satisfied with evidence or adding a missing criterion discovered during implementation.
- If implementation discovers roadmap-level drift — such as invalid slice boundaries, missing prerequisite slices, dependency reordering, or a blocker that changes the current slice contract — the implementer must not silently redesign the plan. It must report the new truth and return control for canonical reconciliation by `completion-regrounder`.
- During re-ground, evaluate each slice's `acceptance_criteria` against current repo truth and update `status` and `evidence` accordingly.
- A slice may only transition to `done` when every acceptance criterion is satisfied with proof in `evidence`.
- Run exactly one implementation slice at a time.
- A slice is not complete unless it lands as a new commit.
- Before selecting or advancing to the next slice after a committed slice, the tracked and unignored worktree must be clean. If it is not clean, treat that dirty state as a blocker to next-slice progression and reopen or continue the latest slice for reconciliation.
- Docs, config, and runbooks must stay truthful to shipped behavior.
- `.agent/verify_completion_stop.sh` is a generated repo-level baseline verifier. Onboarding should create a working version from current repo truth rather than an unconditional failing placeholder.
- Keep slice-specific proof in repo tests or deterministic checks. Refresh `.agent/verify_completion_stop.sh` only when the repo's top-level verification surfaces change or the verifier becomes stale.
- The workflow topology is flat and primary-driven: the main pi session remains the workflow root and invokes at most one completion role at a time.
- No completion role may invoke another completion role during the normal workflow.
- Completion is a sticky workflow. If canonical state says continuation is required, the workflow root must keep advancing through mandatory roles until canonical state switches to `await_user_input`, `blocked`, `paused`, or `done`.
- `continuation_policy == continue` means the workflow root must not stop after a slice or ask the user whether to continue. It must dispatch the next mandatory role directly.
- `continuation_policy == await_user_input` means the workflow root must ask only for the exact missing input and then stop.
- `continuation_policy == blocked` means the workflow root must report the blocker and stop.
- `continuation_policy == paused` means the user explicitly paused the workflow.
- `continuation_policy == done` means canonical final stop reconciliation is complete and the workflow may stop.
- Use `completion-bootstrapper` only for first-time setup or missing tracked contract-file repair.
- Use `completion-regrounder` for canonical re-grounding, slice selection, post-review or post-audit reconciliation, and final stop reconciliation.
- Default scratch space for temporary files is repo-local `.agent/tmp/`.
- Do not write scratch artifacts to `/tmp` or `/private/tmp` by default.
- If a tool or platform behavior explicitly requires OS temp, prefer a scoped path such as `$TMPDIR/pi-completion/<repo-name>/` and treat it as disposable.
- Never keep canonical state, required verification evidence, or the only copy of a deliverable exclusively in temp paths.

## Primary Driver Contract

When `completion-protocol` is loaded by the main pi session, that session becomes the workflow driver only.

The workflow driver may:

- read current repo truth and canonical `.agent` state
- update canonical `.agent/**` state truthfully when needed for handoff
- choose which completion role to invoke next according to the mandatory dispatch table below
- summarize or compare role outputs for the user
- append canonical `.agent/slice-history.jsonl` records, but only as a faithful transcription of actual completion-role outputs
- append canonical `.agent/stop-check-history.jsonl` `judgment` records during the final stop wave, but only as a faithful transcription of actual `completion-stop-judge` outputs

The workflow driver must not, while completion is active and a slice is selected or in progress:

- directly edit non-`.agent/**` tracked product, docs, config, or test files for that slice
- directly create the slice commit
- directly mark a slice implemented, accepted, reopened, reviewed, audited, or judged without the corresponding role output
- bypass the completion roles for convenience
- hand control back to the user between slices merely to ask whether to continue when `continuation_policy == continue`

If the workflow driver detects that the next mandatory action belongs to a completion role, it must invoke that role rather than doing the slice work itself.

## Mandatory Dispatch Table

1. If tracked protocol contract files are missing or first-time onboarding is required, invoke `completion-bootstrapper`.
2. If canonical `.agent` execution state is missing, invalid, contradictory, stale, or ambiguous after compaction or recovery, invoke `completion-regrounder`.
3. If no slice is selected, invoke `completion-regrounder` to reconcile `.agent/plan.json` and return the next exact handoff payload.
4. If a slice is `selected` or `in_progress` and no new slice commit exists yet, invoke `completion-implementer`.
5. If the latest committed slice lacks a review result, invoke `completion-reviewer`.
6. If the latest committed slice lacks an audit result, invoke `completion-auditor`.
7. If review or audit have returned and canonical reconciliation is needed, invoke `completion-regrounder`. `completion-regrounder` must not select or hand off a next slice while the latest committed slice leaves the tracked and unignored worktree dirty; instead it must reopen or continue that latest slice for reconciliation.
8. If all planned slices are done and final closure is being evaluated, invoke the required `completion-stop-judge` sessions directly.
9. After each required `completion-stop-judge` result is faithfully recorded, rerun `bash .agent/verify_completion_stop.sh` and invoke `completion-regrounder` for final stop reconciliation.

The workflow driver must not substitute itself for any mandatory dispatch target above.

## Canonical Files

Tracked repo-contract files:

- `.agent/README.md`
- `.agent/mission.md`
- `.agent/profile.json`
- `.agent/verify_completion_stop.sh`
- `.agent/verify_completion_control_plane.sh`

Ignored canonical execution-state files:

- `.agent/state.json`
- `.agent/plan.json`
- `.agent/active-slice.json`
- `.agent/slice-history.jsonl`
- `.agent/stop-check-history.jsonl`
- `.agent/verification-evidence.json`
- `.agent/*.log`

## Canonical Inputs

Read these when making completion decisions:

- `.agent/mission.md`
- `.agent/README.md`
- `.agent/profile.json`
- `.agent/state.json`
- `.agent/plan.json`
- `.agent/active-slice.json`
- `.agent/slice-history.jsonl`
- `.agent/stop-check-history.jsonl`
- `.agent/verification-evidence.json`

Optional context only:

- `.agent/backlog.md`
- `.agent/handoff.md`
- `.agent/compact.md`

## Scratch Space

- Use `.agent/tmp/` for repo-local temporary files created during completion work.
- `.agent/tmp/` is scratch space only. Do not treat it as canonical state or durable handoff storage.
- Keep `.agent/tmp/` ignored in `.gitignore` alongside other non-contract `.agent/*` execution artifacts.
- Use OS temp only when a tool explicitly requires it, and prefer `$TMPDIR/pi-completion/<repo-name>/` over broad `/tmp` usage.

## Compaction And Recovery

Canonical truth remains in `.agent/**`.

After context compaction, suspected memory loss, stalled-role recovery, or any ambiguous completion state, the workflow driver must re-read:

- `.agent/state.json`
- `.agent/plan.json`
- `.agent/active-slice.json`
- `.agent/verification-evidence.json`

The workflow driver must invoke `completion-regrounder` before continuing whenever any of the following is true:

- `requires_reground` is `true`
- `requires_reground` is unknown because canonical state is missing or unreadable
- `next_mandatory_action` is missing, unknown, or ambiguous
- `active-slice.json` does not match `.agent/plan.json`
- acceptance criteria for the selected or active slice are missing or unclear
- the exact implementer handoff snapshot in `.agent/active-slice.json` is missing, stale, or contradictory

The exact implementer handoff now includes implementation-scope surfaces and expected verification commands in addition to the locked slice goal, acceptance, notes, and before-slice counters.

The workflow driver must not continue implementation, review, audit, or stop evaluation from compacted conversation memory alone.

After compaction or recovery, `completion-implementer` must also re-read canonical `.agent/state.json`, `.agent/plan.json`, `.agent/active-slice.json`, and `.agent/verification-evidence.json` before resuming work. If `.agent/active-slice.json` still contains a truthful exact handoff snapshot, continue from canonical state rather than asking the user to resend the original caller payload.

## Shared Report Header

All completion reports must begin with:

- `MISSION ANCHOR: ...`
- `Remaining contract IDs: ...`

If a role-specific fixed format uses before/after wording, keep the same mission-anchor first line and then follow that role's exact format.

## Structured Evaluation Rubric Foundation

`completion-reviewer`, `completion-auditor`, and `completion-stop-judge` must emit rubric-backed evaluations using the same shared dimension names and verdict semantics.

The shared rubric foundation now sits alongside canonical `task_type` and `evaluation_profile` signaling in the control plane. That signaling is routing metadata only; later slices may still add stricter profile-aware rubric-output enforcement.

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

## References

Read these bundled references when you need the full protocol or scaffolding material:

- `references/completion.md`
