# @linimin/pi-letscook

Pi package for long-running coding workflows with canonical repo-local `.agent/**` state.

## What it gives you

- `/cook` as the single workflow command
- `/cook <goal>` to bootstrap or continue with an explicit goal, enriched by recent discussion before canonical state is written
- `/cook` with no goal to resume an active canonical `.agent/**` workflow, or propose a new round from recent discussion when no active workflow is running
- `/cook <new goal>` on an active workflow asks whether to continue the current mission or abandon it for a replacement workflow; on a completed workflow it starts the next round from the new goal instead of reopening continue/refocus choices
- no duplicate prompt-template aliases for core workflow commands
- role-based isolated subprocess execution via `completion_role`
- completion widget sourced from canonical `.agent/**` state when no role is actively running, with no completion status line
- richer live role observability that keeps tool activity separate from role progress, rationale, next-step, verification, and state-delta output
- deterministic waiting/stalled signaling for running completion roles
- custom compaction continuity capsule
- canonical transcription of reviewer, auditor, regrounder, and stop-judge outputs
- repo-local verifier scripts and `.gitignore` wiring

## Quick start

In a git repo, after installing the package:

```text
/cook build feature X end-to-end with tests and docs
```

If you stop and come back later while that workflow is still active:

```text
/cook
```

If you want to replace the active workflow with a new goal:

```text
/cook fix onboarding crash first, with regression tests
```

If the previous workflow is already done and you want to start the next round from an explicit goal:

```text
/cook ship the next workflow round for richer /cook startup proposals
```

## Install

### Try temporarily from a local checkout

```bash
pi -e /absolute/path/to/pi-letscook
```

### Install globally from a local checkout

```bash
pi install /absolute/path/to/pi-letscook
```

### Install into a project from a local checkout

```bash
pi install -l /absolute/path/to/pi-letscook
```

### Install from git after publishing

```bash
pi install git:github.com/<YOUR-USER>/pi-letscook@v0.1.0
```

### Install from npm after publishing

```bash
pi install npm:@linimin/pi-letscook
```

After install, run `/reload` in pi. For this package, it is safest to reload when pi is idle and no `completion_role` is currently running.

## Usage patterns

### Mental model

`/cook` is the single entrypoint for this package, but its behavior depends on the current canonical workflow state.

| Repo state | `/cook` | `/cook <goal>` |
|---|---|---|
| No canonical workflow yet | Proposes a startup plan from recent discussion, then asks for confirmation | Builds a startup proposal anchored on the explicit goal, enriches it from recent discussion, then asks for confirmation |
| Active workflow exists | Resumes the active workflow from canonical `.agent/**` state | Asks whether to continue the current workflow or replace it with a new one |
| Previous workflow is already `done` | Proposes the next workflow round from recent discussion, then asks for confirmation | Starts the next workflow round from the explicit goal, using recent discussion only as supplemental proposal context |

### One-step start

```text
/cook Build feature X with tests and docs
```

This bootstraps `.agent/**` if missing, derives a clean initial `MISSION ANCHOR`, builds a startup proposal, lets you confirm or edit it, re-grounds canonical state, creates a slice plan, and drives the workflow.

When you pass an explicit goal, that goal stays the mission anchor. Recent discussion is only used to fill in extra scope, constraints, and acceptance details before canonical state is written.

### Resume later

```text
/cook
```

If canonical `.agent/**` state already exists and is still active, `/cook` with no goal resumes from that state.

### Replace the active workflow

```text
/cook fix onboarding crash first, with regression tests
```

If a workflow is still active, `/cook <goal>` asks whether to:

- continue the current workflow, or
- abandon the current workflow and start this new one

If you replace the active workflow, `/cook` rebuilds canonical state from the new goal and restarts from `reground`.

### Start the next round after completion

```text
/cook ship the next workflow round for richer /cook startup proposals
```

If the previous workflow is already `done`, `/cook <goal>` starts the next workflow round directly from that explicit goal. It does not reopen the old continue/refocus choice. Recent discussion is only used as supplemental proposal context.

### Start the next round from discussion only

```text
/cook
```

If the previous workflow is already `done`, `/cook` with no goal tries to infer the next plan from recent discussion, asks you to confirm it, and then starts the next workflow round from refreshed canonical state.

## Canonical repo files

This package manages repo-local canonical workflow state under:

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

Canonical truth lives in these files plus current repo truth.

## Live observability surfaces

When canonical `.agent/**` state exists and no role is actively running, the extension shows a completion widget sourced from that state. The non-running widget summarizes the current phase, selected slice, next mandatory role, and remaining work counts; there is no completion status line.

While a `completion_role` subprocess is running, the widget is intentionally suppressed. Tool execution is rendered separately from assistant-provided `PROGRESS`, `RATIONALE`, `NEXT`, `VERIFYING`, and `STATE-DELTA` lines so operators can tell the difference between tool work, role judgment, and verification. The running-role display still emits deterministic active/waiting/stalled signaling from the role timestamps instead of silently looking idle.

## Package layout

- `extensions/completion/index.ts` — workflow extension
- `skills/completion-protocol/` — shared protocol docs
- `agents/completion-*.md` — package-local completion roles used by the extension
- `scripts/` — smoke and release checks

## Development and release

Run validation from the package root:

```bash
npm run smoke-test
npm run refocus-test
npm run context-proposal-test
npm run observability-status-test
npm run release-check
```

`npm run release-check` is the broader packaged-release verifier. It reruns the smoke, refocus, and context-proposal checks, includes the deterministic observability regression coverage, and finishes with `npm pack --dry-run`.

See [PUBLISHING.md](./PUBLISHING.md) for GitHub and npm release steps.

## Notes

- Canonical truth lives in repo-local `.agent/**` files.
- The main pi session is the workflow driver.
- Package-local role prompts are loaded directly by the extension; they do not rely on `~/.pi/agent/agents`.
- Reviewer, auditor, and stop-judge are enforced as read-only roles.
