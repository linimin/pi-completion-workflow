# Changelog

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
