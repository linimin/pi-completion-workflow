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
- `.agent/*.log`
- `.agent/tmp/`

The source of truth for long-running completion work is canonical `.agent/**` state plus current repo truth.

Project: pi-completion-workflow
