# Changelog

## 0.1.35

### Changed

- brightened the remaining `/cook` completion UI helper text by removing the last `dim` styling from proposal intro/footer/scroll hints and running activity metadata, using plain/default text for higher contrast while keeping stalled activity as warning-colored

## 0.1.34

### Changed

- added evaluator calibration fixtures for semantically lenient but well-formed reviewer/auditor/stop-judge reports and made packaged transcription reject those cases fail closed while still accepting truthful passing fixtures
- tightened the reproducible `none; ...` reviewer/auditor/stop-judge bypass checks while still accepting only the exact reviewer `none; proceed to completion-auditor` routing allowance with terminal punctuation or whitespace only
- wired `npm run evaluator-calibration-test` into `npm run release-check` and `.agent/verify_completion_stop.sh` as part of the packaged release gate
- fixed the smoke auto-resume prompt regression so the packaged release check writes `auto-resume-prompt.txt` again and passes on clean HEAD
- promoted `.agent/active-slice.json` to implementation-contract v2 across implementer instructions, fail-closed active-vs-plan parity checks, recovery/reminder surfaces, and a dedicated release-gated regression
- added durable canonical verification evidence at `.agent/verification-evidence.json`, threaded it through docs and recovery surfaces, and made release/stop verification fail closed on missing, stale, wrong-head, or protocol-doc-drift evidence artifacts
- made `/cook` startup and replacement confirmation approval-only by removing inline Edit and mission-anchor editing paths; the proposal gate now offers only Start or Cancel, and cancel points users back to the main chat before rerunning `/cook`
- kept the separate existing-workflow chooser (`Continue current workflow` / `Abandon current workflow and start this new one` / `Cancel`) while updating the replacement path, README, and deterministic context/refocus regressions to match the new approval-only gate truthfully

## 0.1.33

### Changed

- kept full mission text in `/cook` confirmation instead of truncating mission anchors during derivation
- refined `/cook` activity and completion-role text contrast by reducing overuse of `dim` styling in high-value status surfaces

## 0.1.32

### Changed

- made `/cook` auto-continue workflows from canonical state when `continuation_policy == continue`, so the primary driver re-queues the canonical resume prompt after intermediate role turns instead of parking silently on known mandatory steps
- added smoke coverage for the new auto-resume driver prompt behavior and a guarded parked-state warning path to avoid infinite requeue loops on an unchanged mandatory state

## 0.1.31

### Changed

- defined a shared structured evaluation-rubric contract for `completion-reviewer`, `completion-auditor`, and `completion-stop-judge`, including the exact rubric dimensions `Contract coverage`, `Correctness risk`, `Verification evidence`, and `Docs/state parity` with `pass|concern|fail` verdict semantics
- added canonical `task_type: completion-workflow` and `evaluation_profile: completion-rubric-v1` signaling across the packaged control-plane defaults, verifier schema, and kickoff/reminder/resume surfaces
- expanded the exact active-slice implementer handoff with canonical `implementation_surfaces` and `verification_commands` fields, and now surface them alongside `priority` / `why_now` in reminder and compaction-resume text
- documented the rubric-driven evaluation contract plus canonical routing-profile signaling in the packaged completion protocol and README without adding profile-specific rubric-output enforcement yet
- strengthened the smoke/refocus/context regressions so bootstrap and refocus preserve the new canonical signaling and fail closed when required `task_type` / `evaluation_profile` fields are removed
- strengthened the smoke regression and control-plane verifier so selected-slice handoffs now fail closed when the expanded implementation-contract fields are missing
- threaded canonical `evaluation_profile` plus the active-slice implementation contract into reviewer/auditor/stop-judge reminder and dispatch surfaces so those read-only roles can recover from canonical state instead of prose-only summaries
- made reviewer/auditor/stop-judge transcription fail closed on malformed rubric-bearing outputs while still accepting valid reports, and added deterministic transcription coverage for all three roles in `npm run rubric-contract-test`
- kept deterministic `rubric-contract-test` coverage wired into `npm run release-check`
- made the `/cook` confirmation UI critique-aware by rendering critique/risk notes plus recommended `task_type` / `evaluation_profile` routing hints in dedicated sections while keeping the existing Start/Edit/Cancel flow
- persisted accepted startup/refocus routing choices canonically by writing the selected `task_type` / `evaluation_profile` into the canonical control-plane files and recording the accepted critique outcome in continuation state, with `context-proposal-test` and `release-check` covering the shipped flow

## 0.1.30

### Changed

- clarified the README next-round example so the goal text no longer repeats `/cook` in a way that looks like part of the command syntax

## 0.1.29

### Changed

- tightened the README opening description so it correctly presents this package as a Pi extension that adds `/cook`, rather than implying `/cook` is built into Pi itself

## 0.1.28

### Changed

- added model-assisted `/cook` startup proposal analysis for natural recent discussion with a live `/cook proposal analyst` progress overlay, removed the built-in discussion-parser fallback for discussion-only startup, and preserved explicit-goal mission anchoring even when analyst output is unavailable
- replaced the crowded built-in `/cook` startup proposal selector presentation with a custom confirmation UI that separates proposal content from explicit Start, Edit, and Cancel actions
- fixed `/cook proposal analyst` overlay input handling and improved proposal body readability in the confirmation UI

## 0.1.27

### Changed

- added package metadata for npm and pi.dev discovery, fixed README publishing links for npm rendering, and refined install and workflow guidance after the `v0.1.26` tag

## 0.1.26

### Changed

- clarified the README install guidance and `/cook` behavior matrix, including tracked-vs-ignored `.agent` file explanations, active-workflow replacement examples, and safer `/reload` guidance for completion work

## 0.1.25

### Changed

- `/cook` with no goal can now propose a context-derived startup plan for confirmation when no active workflow exists, including starting a fresh next round after the previous workflow already reached `done`
- `/cook <goal>` now builds a goal-anchored, context-enriched startup proposal before writing canonical state, uses more explicit active-workflow replacement wording, and starts the next round directly from the explicit goal after a completed workflow instead of reopening continue/refocus choices

## 0.1.24

### Changed

- removed the completion status line entirely; the remaining completion widget appears only when no role is actively running

## 0.1.23

### Changed

- renamed the public workflow command from `/complete` to `/cook`
- aligned the published package/install identity around `@linimin/pi-letscook` and `pi-letscook`
- removed the completion status line entirely; the remaining completion widget now appears only when no role is actively running
- kept the richer live role observability lanes and waiting/stalled signaling without reintroducing a status-line surface
- added this current release entry so the shipped `/cook`, package rename, and current completion UI behavior are documented without rewriting older `/complete` history

## 0.1.22

### Changed

- clarified the existing-workflow continue/refocus selection UI with a clearer prompt, current-vs-proposed mission summary, and shorter option descriptions

## 0.1.21

### Changed

- kept the persistent completion status line from canonical `.agent/**` state and live role activity, while suppressing the widget whenever a role is actively running
- separated live running-role observability into distinct tool activity, role judgment, verification, and state-delta lanes with waiting/stalled signaling
- added deterministic observability status regression coverage to the release-check path
- refreshed README and release-verifier guidance so the shipped observability surfaces and verification flow are documented truthfully

## 0.1.18

### Changed

- reduced the public slash-command surface to a single `/complete` entrypoint
- `/complete` with no goal now resumes from canonical `.agent/**` state when present
- `/complete <new goal>` now asks whether to continue the current mission or refocus canonical mission state before continuing
- removed dedicated resume, reground, panel, history, verify, and pause slash commands in favor of the always-visible workflow status
- pruned helper code that only supported the removed slash commands
- added a regression test for existing-workflow refocus handling and included it in release checks

## 0.1.16

### Improved

- richer operator-facing live role execution display with progress, rationale, next-step, verification, and state-delta parsing
- elapsed-time tracking for running completion roles
- no emoji in workflow-specific status, widget, panel, or role execution displays
- role prompts now emit structured `PROGRESS`, `RATIONALE`, `NEXT`, `VERIFYING`, and `STATE-DELTA` lines for observability

## 0.1.15

### Changed

- removed `/completion-status`; rely on the persistent widget/footer and `/completion-panel` for state inspection

## 0.1.14

### Changed

- removed `/completion-init` and made `/complete <goal>` the single bootstrap-and-run entrypoint
- smoke test now validates bootstrap through `/complete`
- docs updated to treat `/complete` as the canonical initialization path

## 0.1.13

### Improved

- persistent footer/widget status is now more compact and useful for day-to-day workflow use
- always-visible status now surfaces live role/action summaries without requiring the panel to be open
- widget lines now favor concise mission, goal, reason, and live activity previews over verbose raw fields

## 0.1.12

### Improved

- `/completion-panel` now live-follows current running role activity
- side panel and print-mode panel output now include current role, current action, recent activity, and assistant-progress previews while a completion role is running

## 0.1.11

### Added

- `/completion-panel` command for an on-demand right-side completion workflow panel
- live panel view for canonical mission, current phase, active slice, remaining work, and recent history
- print-mode fallback that renders panel contents as plain text when interactive UI is unavailable

## 0.1.10

### Improved

- ambiguous bootstrap goals can now trigger developer confirmation or editing of the proposed `MISSION ANCHOR`
- `/complete` and `/completion-init` keep auto-bootstrap for clear goals but ask before writing weak or underspecified anchors into canonical state
- mission-anchor confirmation uses extension UI instead of relying on model-side clarification later in the workflow

## 0.1.9

### Improved

- bootstrap now derives a cleaner `MISSION ANCHOR` from vague `/complete` and `/completion-init` goals
- weak or underspecified goals now fall back to a stable repo-based mission anchor instead of using raw ambiguous text
- common phrasing noise like `/complete`, `please`, and `end-to-end` is normalized before seeding canonical mission state

## 0.1.8

### Fixed

- removed duplicate prompt-template aliases for `/complete`, `/complete-resume`, and `/completion-status`
- package now exposes those names only as extension commands, avoiding duplicate command entries in pi

## 0.1.7

### Fixed

- generated `verify_completion_control_plane.sh` now validates canonical `plan.json` and `active-slice.json` structure instead of only checking JSON parseability
- exact implementer handoff states now require `priority` and `why_now`, matching the completion protocol docs and role expectations
- scaffolded `active-slice.json` now includes `priority` and `why_now` placeholders to avoid schema drift during later role updates
- `ensureGitignore` now repairs duplicated or drifted completion-protocol ignore blocks instead of bailing out on the first marker match
- smoke test now covers the selected active-slice handoff schema regression and fails closed when `priority`/`why_now` are missing

## 0.1.6

### Fixed

- additional stale-context guards for command handlers and completion role execution
- avoid stale ctx access through cwd, hasUI, ui, and system-prompt lookups after session replacement or reload

## 0.1.5

### Fixed

- stale extension context handling after session replacement or reload
- guarded UI status, widget, theme, and notify calls to avoid stale-ctx runtime errors

## 0.1.4

### Improved

- stronger implementer instructions for roadmap-level drift discovered during implementation
- explicit requirement to hand plan repair back to `completion-regrounder` instead of silently redesigning slices
- implementer report now includes `Plan adjustment required: yes/no - ...`

## 0.1.3

### Improved

- richer live progress visibility for `completion_role`
- current action, recent activity, and assistant-progress previews while roles are running
- less opaque role execution UX during long-running workflow steps

## 0.1.2

### Improved

- stronger post-compaction driver recovery instructions
- transient post-compaction recovery marker with automatic cleanup after recovery turn
- stricter canonical-file-first continuation guidance after compaction

## 0.1.1

### Improved

- print-mode output for `/completion-status`, `/completion-history`, `/completion-verify`, and `/completion-pause`
- package-local runtime polish for release workflow

## 0.1.0

Initial packaged release of `pi-completion-workflow`.

### Added

- pi package manifest with extension, skills, prompts, and role agents
- canonical `.agent/**` scaffolding via `/completion-init`
- workflow entrypoints: `/complete` and `/complete-resume`
- workflow inspection commands: `/completion-status`, `/completion-history`, `/completion-verify`
- pause and re-ground commands
- isolated `completion_role` execution for role-based subagents
- canonical transcription of reviewer, auditor, regrounder, and stop-judge outputs
- custom compaction continuity support
- release smoke test script
