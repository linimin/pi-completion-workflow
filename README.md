# @linimin/pi-letscook

A Pi extension that adds `/cook` for resumable long-running workflows backed by repo-local canonical state in `.agent/**`.

`@linimin/pi-letscook` is for work that does not fit in a single chat turn:

- start from a goal or from recent discussion
- resume later from repo-local workflow state
- refocus an active workflow without losing control of the mission
- drive implementation through isolated completion roles
- keep verification, review, audit, and stop checks tied to the repo

## Why use it

Use this package when you want `/cook` to behave like a real project workflow command instead of a one-shot prompt.

It gives you:

- **one command** for start, resume, and refocus
- **repo-local canonical state** under `.agent/**`
- **model-assisted startup proposals** from recent discussion
- **explicit-goal anchoring** when you want the mission to stay fixed
- **isolated completion roles** via `completion_role`
- **deterministic verification** through repo-local scripts and regression checks

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

Start the next round after the previous workflow is already done:

```text
/cook improve startup proposal confirmation UX
```

## How `/cook` behaves

`/cook` is the only public workflow command, but it behaves differently depending on the current canonical workflow state.

| Repo state | `/cook` | `/cook <goal>` |
|---|---|---|
| No canonical workflow yet | Uses the proposal analyst to summarize recent discussion into a startup proposal, then asks for confirmation | Builds a startup proposal anchored on the explicit goal, optionally enriching it from recent discussion, then asks for confirmation |
| Active workflow exists | Resumes the active workflow from canonical `.agent/**` state | Asks whether to continue the current workflow or replace it |
| Previous workflow is already `done` | Uses the proposal analyst to summarize recent discussion into the next workflow round, then asks for confirmation | Starts the next workflow round directly from the explicit goal |

## Startup proposal behavior

### `/cook <goal>`

When you provide an explicit goal:

- the explicit goal stays the mission anchor
- recent discussion is supplemental only
- recent discussion may enrich scope, constraints, and acceptance details when analyst output is available

Example:

```text
/cook Build feature X with tests and docs
```

### `/cook` without a goal

When you do **not** provide a goal:

- `/cook` uses the proposal analyst to summarize recent discussion into a startup proposal
- the proposal is shown in a custom confirmation UI before canonical state is written
- if analyst output is unavailable, provide an explicit goal with `/cook <goal>`

Example:

```text
/cook
```

## Confirmation UI

Startup confirmation uses a custom UI that:

- renders the proposal body separately from the action list
- keeps Mission / Scope / Constraints / Acceptance readable as a content area
- renders analyst-derived **Critique and risks** separately from the editable proposal body
- renders recommended `task_type` / `evaluation_profile` routing hints separately from both the proposal body and the action list
- presents explicit actions for:
  - **Start**
  - **Edit**
  - **Cancel**

When you accept startup or refocus from that flow, `/cook` now persists the chosen `task_type` and `evaluation_profile` across `.agent/profile.json`, `.agent/state.json`, `.agent/plan.json`, and `.agent/active-slice.json`, and records the accepted critique outcome in canonical continuation state before the re-ground round begins.

The same confirmation flow is reused across:

- discussion-only startup
- explicit-goal startup
- next-round startup after completion
- replacement-workflow startup

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

The active-slice exact implementer handoff now also carries a stronger implementation contract for selected, in-progress, committed, and done slices:

- `implementation_surfaces` — the repo surfaces expected to change or stay in parity for the slice
- `verification_commands` — the focused and broader deterministic checks the implementer is expected to run before committing

Those fields are scaffolded by default, enforced by `.agent/verify_completion_control_plane.sh` whenever an exact handoff is required, and surfaced alongside `priority` / `why_now` in reminder and compaction-resume text so implementers can recover from canonical state instead of prose-only summaries.

Reviewer, auditor, and stop-judge dispatch/reminder surfaces now also thread the current active-slice implementation contract (`implementation_surfaces`, `verification_commands`, locked notes, must-fix findings, and before-slice counters) alongside the canonical `evaluation_profile` so those read-only roles can reason from canonical state after compaction.

Canonical reviewer/auditor/stop-judge transcription now fails closed on malformed rubric-bearing reports: the shared rubric heading plus all four rubric dimensions must be present, required role fields must remain intact, and reviewer/stop-judge yes/no verdicts cannot contradict rubric `fail` lines.

Evaluator calibration now also fails closed on semantically lenient but well-formed reports. `npm run evaluator-calibration-test` drives the packaged transcription path through reviewer yes-with-follow-up, auditor open-contracts-with-`Next mandatory slice: none`, and stop-judge yes-with-open-contracts fixtures while still accepting truthful passing reports. Both `npm run release-check` and `bash .agent/verify_completion_stop.sh` include this calibration gate.

Deterministic verification for this packaged contract lives in `npm run rubric-contract-test`, which now exercises reviewer, auditor, and stop-judge transcription paths while the bootstrap/refocus/context regressions plus control-plane verifier fail closed when required canonical signaling is missing.

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
npm run observability-status-test
npm run evaluator-calibration-test
npm run rubric-contract-test
npm run release-check
```

`npm run release-check` is the broad packaged-release verifier. It reruns the startup/refocus/context checks — including the critique-aware `/cook` confirmation regression and the smoke auto-resume prompt path — includes deterministic observability coverage plus evaluator calibration and the rubric-contract regression, and finishes with `npm pack --dry-run`.

## Release

See [PUBLISHING.md](https://github.com/linimin/pi-letscook/blob/main/PUBLISHING.md) for GitHub and npm release steps.

## Notes

- Canonical truth lives in repo-local `.agent/**` files.
- The main Pi session is the workflow driver.
- Package-local role prompts are loaded directly by the extension and do not depend on `~/.pi/agent/agents`.
- Reviewer, auditor, and stop-judge are enforced as read-only roles.
- Reviewer, auditor, and stop-judge share the packaged rubric dimensions `Contract coverage`, `Correctness risk`, `Verification evidence`, and `Docs/state parity` with `pass|concern|fail` verdicts.
