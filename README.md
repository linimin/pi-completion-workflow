# @linimin/pi-letscook

Pi package for long-running coding workflows with canonical repo-local `.agent/**` state.

## What it gives you

- `/cook` as the single workflow command
- `/cook <goal>` to bootstrap or continue with an explicit goal
- `/cook` with no goal to resume from canonical `.agent/**` state
- `/cook <new goal>` on an existing workflow asks whether to continue the current mission or refocus it
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

If you stop and come back later:

```text
/cook
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

After install, run `/reload` in pi.

## Usage patterns

### One-step start

```text
/cook Build feature X with tests and docs
```

This will bootstrap `.agent/**` if missing, derive a clean initial `MISSION ANCHOR`, optionally ask you to confirm or edit it when the goal is ambiguous, re-ground canonical state, create a slice plan, and drive the workflow.

### Resume later

```text
/cook
```

If canonical `.agent/**` state already exists, `/cook` with no goal resumes from that state. If you pass a new goal while a workflow already exists, the extension asks whether to keep the current mission anchor or refocus it before continuing.

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
npm run observability-status-test
npm run release-check
```

`npm run release-check` is the broader packaged-release verifier. It reruns the smoke and refocus checks, includes the deterministic observability regression coverage, and finishes with `npm pack --dry-run`.

See [PUBLISHING.md](./PUBLISHING.md) for GitHub and npm release steps.

## Notes

- Canonical truth lives in repo-local `.agent/**` files.
- The main pi session is the workflow driver.
- Package-local role prompts are loaded directly by the extension; they do not rely on `~/.pi/agent/agents`.
- Reviewer, auditor, and stop-judge are enforced as read-only roles.
