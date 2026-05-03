# @linimin/pi-letscook

A Pi extension that turns `/cook` into a repo-local workflow command for long-running coding work.

## Why this exists

Normal chat is good for one-off tasks. It is much worse for work that needs to:

- continue across sessions
- stay anchored to one mission
- resume from repo state instead of chat memory
- keep review, audit, and verification tied to the repo

`@linimin/pi-letscook` solves that by storing canonical workflow state in `.agent/**` and using `/cook` to start, resume, or refocus the workflow.

## What you get

- one command: `/cook`
- repo-local canonical state in `.agent/**`
- resumable long-running workflows
- startup proposals from an explicit goal or recent discussion
- deterministic verification, review, audit, and stop checks

## Install

```bash
pi install npm:@linimin/pi-letscook
```

Then run `/reload` in Pi.

## Quick start

Start from an explicit goal:

```text
/cook build feature X end-to-end with tests and docs
```

Resume an active workflow:

```text
/cook
```

Replace the active workflow with a different goal:

```text
/cook fix onboarding crash first, with regression tests
```

## How `/cook` works

`/cook` is the only public workflow command, but it reacts to canonical workflow state:

| Repo state | `/cook` | `/cook <goal>` |
|---|---|---|
| No workflow yet | Summarizes recent discussion into a startup proposal, then asks for approval | Builds a proposal anchored on the explicit goal, then asks for approval |
| Active workflow exists | Resumes from canonical `.agent/**` state | First asks whether to continue or replace the current workflow |
| Previous workflow is `done` | Starts the next round from recent discussion | Starts the next round from the explicit goal |

## Startup confirmation

Startup and replacement proposals are **approval-only**:

- the proposal body is shown separately from actions
- actions are only **Start** and **Cancel**
- if the proposal needs changes, **Cancel**, discuss them in the main chat, and rerun `/cook`

When an active workflow already exists and you run `/cook <goal>`, `/cook` still shows a separate chooser first:

- **Continue current workflow**
- **Abandon current workflow and start this new one**
- **Cancel**

Only the follow-on startup/replacement proposal uses the approval-only Start/Cancel gate.

When you accept startup or refocus from that flow, `/cook` persists the chosen `task_type` and `evaluation_profile` across `.agent/profile.json`, `.agent/state.json`, `.agent/plan.json`, and `.agent/active-slice.json`, and records the accepted critique outcome in canonical continuation state before the re-ground round begins.

## Observability

When canonical `.agent/**` state exists and no role is actively running, the extension shows a completion widget sourced from that state. The widget summarizes:

- current phase
- selected slice
- next mandatory role
- remaining work counts

There is no completion status line.

While a `completion_role` subprocess is running:

- the non-running widget is suppressed
- tool activity is shown separately from assistant-reported progress
- running-role output distinguishes tool work from `PROGRESS`, `RATIONALE`, `NEXT`, `VERIFYING`, and `STATE-DELTA`
- waiting and stalled states are surfaced deterministically from timestamps

## Structured evaluation rubrics

The packaged completion workflow now defines a shared structured evaluation-rubric contract for the read-only evaluation roles:

- `completion-reviewer`
- `completion-auditor`
- `completion-stop-judge`

Those roles now use the same rubric section and exact dimension names:

- `Contract coverage`
- `Correctness risk`
- `Verification evidence`
- `Docs/state parity`

Each rubric line uses the same verdict words:

- `pass` — no material issue remains for that dimension
- `concern` — a real caveat or remaining gap exists, but it does not by itself force rejection or `NO-STOP`
- `fail` — a blocking issue or contradictory truth exists, so the role's final verdict must not be positive

The packaged control plane now also carries canonical routing signals:

- `task_type: completion-workflow`
- `evaluation_profile: completion-rubric-v1`

Those identifiers are persisted in `.agent/profile.json`, `.agent/state.json`, `.agent/plan.json`, and `.agent/active-slice.json`, then surfaced in kickoff/reminder/resume text and reviewer/auditor/stop-judge evaluation handoffs so downstream roles can rely on canonical signaling instead of prose inference alone.

The active-slice exact implementer handoff is now the canonical implementation contract for selected, in-progress, committed, and done slices. In addition to the locked slice goal, acceptance criteria, contract IDs, blocked-on list, `priority`, and `why_now`, the v2 contract requires:

- `implementation_surfaces` — the repo surfaces expected to change or stay in parity for the slice
- `verification_commands` — the focused and broader deterministic checks the implementer is expected to run before committing
- `locked_notes` / `must_fix_findings` — canonical scope locks plus review follow-up obligations for the current slice
- `basis_commit` — the clean HEAD the slice was selected against
- `remaining_contract_ids_before` plus `release_blocker_count_before` / `high_value_gap_count_before` — the locked before-slice counters the implementer must preserve in reports and later handoffs

The selected plan slice must mirror that exact contract across goal, contract IDs, acceptance criteria, blocked-on state, `priority` / `why_now`, `implementation_surfaces`, `verification_commands`, locked notes, must-fix findings, `basis_commit`, and the before-slice counters. `.agent/verify_completion_control_plane.sh` plus the reminder/compaction-resume surfaces now fail closed on that drift instead of only checking slice-id presence, so implementers can recover from canonical state rather than prose-only summaries.

Reviewer, auditor, and stop-judge dispatch/reminder surfaces now also thread the current active-slice implementation contract (`implementation_surfaces`, `verification_commands`, locked notes, must-fix findings, `basis_commit`, and before-slice counters) alongside the canonical `evaluation_profile` so those read-only roles can reason from canonical state after compaction.

Deterministic verification now also persists a durable canonical artifact in `.agent/verification-evidence.json`. Fresh scaffolds create an idle placeholder, implementers update it for the selected slice or current HEAD, reminder/recovery/evaluation surfaces thread its path and summary, and `.agent/verify_completion_control_plane.sh`, `bash scripts/canonical-evidence-artifact-test.sh`, `npm run release-check`, and `bash .agent/verify_completion_stop.sh` fail closed when that artifact is missing, stale, or out of parity with the selected slice or current HEAD.

Canonical reviewer/auditor/stop-judge transcription now fails closed on malformed rubric-bearing reports: the shared rubric heading plus all four rubric dimensions must be present, required role fields must remain intact, and reviewer/stop-judge yes/no verdicts cannot contradict rubric `fail` lines.

Evaluator calibration now also fails closed on semantically lenient but well-formed reports. `npm run evaluator-calibration-test` drives the packaged transcription path through reviewer yes-with-follow-up, auditor open-contracts-with-`Next mandatory slice: none`, and stop-judge yes-with-open-contracts fixtures while still accepting truthful passing reports. It also rejects the reproducible `none; ...` bypass family for reviewer follow-up, auditor worktree blockers, and stop-judge open-contract reporting, while still accepting only the exact reviewer routing text `Smallest follow-up slice: none; proceed to completion-auditor.` with terminal punctuation or whitespace only. Both `npm run release-check` and `bash .agent/verify_completion_stop.sh` include this calibration gate.

Deterministic active-slice contract regression now lives in `bash scripts/active-slice-contract-test.sh`, and `npm run release-check` pulls it into the packaged release gate before `npm pack --dry-run`.

Deterministic verification for this packaged contract also lives in `npm run rubric-contract-test`, which now exercises reviewer, auditor, and stop-judge transcription paths while the bootstrap/refocus/context regressions plus control-plane verifier fail closed when required canonical signaling is missing.

## Canonical files

This package stores canonical workflow state under:

```text
.agent/
  README.md
  mission.md
  profile.json
  verify_completion_stop.sh
  verify_completion_control_plane.sh
  state.json
  plan.json
  active-slice.json
  slice-history.jsonl
  stop-check-history.jsonl
  verification-evidence.json
  tmp/
```

Canonical truth is the combination of:

- current repo truth, and
- canonical `.agent/**` state

### Tracked vs ignored files

Tracked repo-contract files:

- `.agent/README.md`
- `.agent/mission.md`
- `.agent/profile.json`
- `.agent/verify_completion_stop.sh`
- `.agent/verify_completion_control_plane.sh`

Ignored execution-state files:

- `.agent/state.json`
- `.agent/plan.json`
- `.agent/active-slice.json`
- `.agent/slice-history.jsonl`
- `.agent/stop-check-history.jsonl`
- `.agent/verification-evidence.json`
- `.agent/*.log`
- `.agent/tmp/`

In short:

- tracked `.agent` files define the repo-level workflow contract
- ignored `.agent` files are the local control-plane state for the current run

## Package layout

- `extensions/completion/index.ts` — main extension implementation
- `skills/completion-protocol/` — shared protocol documentation
- `agents/completion-*.md` — package-local completion role prompts
- `scripts/` — smoke, regression, and release checks

## Development

Run validation from the package root:

```bash
npm run smoke-test
npm run refocus-test
npm run context-proposal-test
bash scripts/canonical-evidence-artifact-test.sh
npm run observability-status-test
npm run evaluator-calibration-test
npm run rubric-contract-test
npm run release-check
```

`npm run release-check` is the broad packaged-release verifier. It begins with `bash .agent/verify_completion_control_plane.sh`, so missing or stale `.agent/verification-evidence.json` parity fails closed before the broader suite runs, then reruns the startup/refocus/context checks — including the critique-aware `/cook` confirmation regression and the smoke auto-resume prompt path — includes deterministic canonical evidence artifact coverage and includes deterministic active-slice contract coverage plus observability coverage, evaluator calibration, and the rubric-contract regression, and finishes with `npm pack --dry-run`.

## Release

See [PUBLISHING.md](https://github.com/linimin/pi-letscook/blob/main/PUBLISHING.md) for GitHub and npm release steps.

## Notes

- Canonical truth lives in repo-local `.agent/**` files.
- The main Pi session is the workflow driver.
- Package-local role prompts are loaded directly by the extension and do not depend on `~/.pi/agent/agents`.
- Reviewer, auditor, and stop-judge are enforced as read-only roles.
- Reviewer, auditor, and stop-judge share the packaged rubric dimensions `Contract coverage`, `Correctness risk`, `Verification evidence`, and `Docs/state parity` with `pass|concern|fail` verdicts.
