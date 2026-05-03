# Completion Control Plane

This repository uses the `completion` workflow for long-running coding tasks.

## Canonical tracked contract files

- `.agent/README.md`
- `.agent/mission.md`
- `.agent/profile.json`
- `.agent/verify_completion_stop.sh`
- `.agent/verify_completion_control_plane.sh`

## Ignored canonical execution state

- `.agent/state.json`
- `.agent/plan.json`
- `.agent/active-slice.json`
- `.agent/slice-history.jsonl`
- `.agent/stop-check-history.jsonl`
- `.agent/verification-evidence.json`
- `.agent/*.log`
- `.agent/tmp/`

`.agent/verification-evidence.json` is the durable canonical record of deterministic verification for the selected slice or current HEAD. Recovery, review, audit, and stop-check reminder surfaces should consume it instead of temp-only artifacts or conversational summaries when it is populated.

The source of truth for long-running completion work is canonical `.agent/**` state plus current repo truth.

Project: pi-completion-workflow
