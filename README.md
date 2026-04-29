# pi-completion-workflow

Pi package for long-running coding workflows with canonical repo-local `.agent/**` state.

## What it gives you

- `/complete <goal>` to start or continue the workflow
- `/complete-resume` to resume from canonical `.agent/**` state
- no duplicate prompt-template aliases for core workflow commands
- `/completion-init [mission]` to scaffold control-plane files
- `/completion-status`, `/completion-history`, `/completion-panel`, and `/completion-verify`
- role-based isolated subprocess execution via `completion_role`
- compact persistent footer/widget workflow status with live role/action previews
- custom compaction continuity capsule
- canonical transcription of reviewer, auditor, regrounder, and stop-judge outputs
- repo-local verifier scripts and `.gitignore` wiring

## Quick start

In a git repo, after installing the package:

```text
/complete build feature X end-to-end with tests and docs
```

Useful follow-up commands:

```text
/completion-status
/completion-history 20
/completion-verify
```

If you stop and come back later:

```text
/complete-resume
```

## Install

### Try temporarily from a local checkout

```bash
pi -e /absolute/path/to/pi-completion-workflow
```

### Install globally from a local checkout

```bash
pi install /absolute/path/to/pi-completion-workflow
```

### Install into a project from a local checkout

```bash
pi install -l /absolute/path/to/pi-completion-workflow
```

### Install from git after publishing

```bash
pi install git:github.com/<YOUR-USER>/pi-completion-workflow@v0.1.0
```

### Install from npm after publishing

```bash
pi install npm:pi-completion-workflow
```

After install, run `/reload` in pi.

## Usage patterns

### One-step start

```text
/complete Build feature X with tests and docs
```

This will bootstrap `.agent/**` if missing, derive a clean initial `MISSION ANCHOR`, optionally ask you to confirm or edit it when the goal is ambiguous, re-ground canonical state, create a slice plan, and drive the workflow.

### Explicit bootstrap first

```text
/completion-init Build feature X with tests and docs
/complete-resume
```

### Operational commands

- `/completion-status` — show canonical workflow state
- `/completion-history [count]` — show recent canonical records
- `/completion-panel` — open a right-side workflow panel, or print panel text in non-interactive mode; now also follows live running-role activity
- `/completion-verify` — run control-plane and stop verifiers
- `/completion-reground` — force canonical re-ground
- `/completion-pause` — mark the workflow paused in canonical state

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

## Package layout

- `extensions/completion/index.ts` — workflow extension
- `skills/completion-protocol/` — shared protocol docs
- `agents/completion-*.md` — package-local completion roles used by the extension
- `scripts/` — smoke and release checks

## Development and release

Run validation from the package root:

```bash
npm run smoke-test
npm run release-check
```

See [PUBLISHING.md](./PUBLISHING.md) for GitHub and npm release steps.

## Notes

- Canonical truth lives in repo-local `.agent/**` files.
- The main pi session is the workflow driver.
- Package-local role prompts are loaded directly by the extension; they do not rely on `~/.pi/agent/agents`.
- Reviewer, auditor, and stop-judge are enforced as read-only roles.
