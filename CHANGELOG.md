# Changelog

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
