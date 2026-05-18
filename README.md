# @linimin/pi-letscook

`/cook` turns main-chat discussion about concrete repo changes into a resumable repo workflow stored in repo-local `.agent/**` state.

Assist-mode natural-language handoff can also offer to enter that same `/cook` flow before the primary agent starts implementation work, but `/cook` remains the canonical workflow boundary.

## Use it when

- work spans multiple sessions
- you want one mission tracked in repo state instead of chat memory
- you want clear continue / refocus / next-round behavior
- you want review, audit, and verification tied to the repo

## Skip it when

- you only need a one-off answer
- you are brainstorming
- you are writing planning docs but are not ready to start concrete repo changes

## Install

```bash
pi install npm:@linimin/pi-letscook
```

Then run `/reload` in Pi.

## 30-second quick start

1. Install the package:
   `pi install npm:@linimin/pi-letscook`
2. Run `/reload` in Pi.
3. In the main chat, describe the concrete repo change you want.
4. Run `/cook` or `/cook <hint>`.
5. Review the proposal and choose **Start** or **Cancel**.
6. Later, run `/cook` again to continue, refocus, or start the next round.

```text
/cook
/cook login redirect
```

## Common actions

| If you want to... | Do this |
|---|---|
| Start a long-running task | Discuss the concrete repo change in the main chat, then run `/cook` |
| Bias mission detection toward one intent | Run `/cook <hint>` |
| Hand off from discussion into the same `/cook` flow | Say `開始做`, `開始實作`, or `go ahead`, then accept the confirmation |
| Continue the current workflow | Run `/cook` |
| Use the canonical fallback when the natural-language trigger does not fire | Run `/cook` explicitly |

## What `/cook` expects

- recent main-chat discussion about concrete repo changes
- README/CHANGELOG updates still count as concrete repo changes
- assistant-produced summaries and plan/spec/design-doc/proposal-only artifacts do not

`/cook <hint>` acts as a high-priority intent hint for interpreting recent discussion, but it does not bypass fail-closed behavior or the approval-only Start/Cancel confirmation flow.

If recent discussion is missing, weak, ambiguous, assistant-produced, or only describes planning artifacts instead of concrete repo changes, `/cook` fails closed, leaves canonical `.agent/**` state unchanged, and tells you to clarify the mission in the main chat before rerunning `/cook`.

## Natural-language handoff (assist mode)

After you have discussed a concrete repo change in the main chat, short execution handoff phrases such as `開始做`, `開始實作`, or `go ahead` can offer to enter the same `/cook` flow before the primary agent starts implementation work.

Important behavior:
- the handoff is only a shortcut into `/cook`; `/cook` is still the canonical workflow boundary
- it asks for confirmation before `/cook` takes over
- if the trigger is unclear or unavailable, nothing is auto-started and you can run `/cook` explicitly
- ordinary questions and explicit slash commands continue normally

## Typical examples

Start a new workflow from recent discussion:

```text
I want to add login redirect handling and tests.
/cook
```

Bias proposal derivation toward a specific intent:

```text
/cook login redirect
```

Hand off from discussion into the same `/cook` flow:

```text
We should implement the natural-language routing path next.
開始做
```

## What happens when you run `/cook`

`/cook` supports both bare discussion-driven startup and optional inline intent hints. Assist-mode natural-language handoff is optional; explicit `/cook` is always the canonical fallback.

| Repo state | What you'll see |
|---|---|
| No workflow yet | A startup proposal built from recent main-chat discussion. You choose **Start** or **Cancel**. Weak or planning-only discussion fails closed. |
| Active workflow exists | Usually a resume of the current workflow. If recent discussion clearly points to a different concrete repo change, `/cook` shows a chooser first and only rewrites canonical state after confirmation. Ambiguous discussion stays conservative. |
| Previous workflow is `done` | A next-round proposal from recent main-chat discussion, again behind **Start** or **Cancel**. Discussion that only restates already-finished work fails closed. |

## Confirmation and fail-closed behavior

`/cook` never silently starts or rewrites canonical `.agent/**` state on unclear input.

- startup, next-round, and refocus proposals are approval-only
- actions are **Start** and **Cancel**
- **Cancel** is side-effect free: discuss changes in the main chat and rerun `/cook`
- weak, ambiguous, assistant-produced, or planning-only discussion does not start a workflow
- when recent discussion suggests a different workflow, `/cook` shows a chooser before any canonical state rewrite

When you accept startup or refocus, `/cook` persists the chosen workflow state in canonical `.agent/**` files before the re-ground round begins.

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

## Maintainer and protocol details

The sections below are mainly useful if you maintain the extension, inspect canonical `.agent/**` state, or work on the packaged completion protocol itself.

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
bash ./scripts/cook-trigger-routing-test.sh
bash scripts/canonical-evidence-artifact-test.sh
npm run observability-status-test
npm run evaluator-calibration-test
npm run rubric-contract-test
npm run release-check
```

`npm run release-check` is the broad packaged-release verifier. It begins with `bash .agent/verify_completion_control_plane.sh`, so missing or stale `.agent/verification-evidence.json` parity fails closed before the broader suite runs, then asserts the shipped single-command `/cook` public parity surfaces in `README.md`, `CHANGELOG.md`, and the `/cook` help/fail-closed copy in `extensions/completion/index.ts`, reruns `bash ./scripts/cook-trigger-routing-test.sh` for the assist-mode natural-language handoff path, reruns the startup/refocus/context checks — including the critique-aware `/cook` confirmation regression and the smoke auto-resume prompt path — includes deterministic canonical evidence artifact coverage and includes deterministic active-slice contract coverage plus observability coverage, evaluator calibration, and the rubric-contract regression, and finishes with `npm pack --dry-run`.

The direct package-root verifier commands above intentionally self-isolate the repo-local extension when they shell back into `pi`, so you should not need to wrap them with `pi --no-extensions` even if `@linimin/pi-letscook` is also installed globally on the same machine.

## Release

See [PUBLISHING.md](https://github.com/linimin/pi-letscook/blob/main/PUBLISHING.md) for GitHub and npm release steps.

## Notes

- Canonical truth lives in repo-local `.agent/**` files.
- The main Pi session is the workflow driver.
- Package-local role prompts are loaded directly by the extension and do not depend on `~/.pi/agent/agents`.
- Reviewer, auditor, and stop-judge are enforced as read-only roles.
- Reviewer, auditor, and stop-judge share the packaged rubric dimensions `Contract coverage`, `Correctness risk`, `Verification evidence`, and `Docs/state parity` with `pass|concern|fail` verdicts.
