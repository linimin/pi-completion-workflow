#!/usr/bin/env bash
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

assert_status_json() {
  local json_path="$1"
  local mode="$2"
  python3 - "$json_path" "$mode" <<'PY'
import json
import sys
from pathlib import Path

json_path = Path(sys.argv[1])
mode = sys.argv[2]
assert json_path.exists(), f"missing status probe output: {json_path}"
data = json.loads(json_path.read_text())

if mode == 'none':
    assert data['snapshotPresent'] is False, data
    assert not data.get('statusText'), data
    assert data['widgetLines'] == [], data
elif mode == 'static':
    assert data['snapshotPresent'] is True, data
    assert data['currentPhase'] == 'implement', data
    assert data['sliceId'] == 'fixture-status-surface', data
    assert data['nextMandatoryRole'] == 'completion-implementer', data
    assert data['remainingContractCount'] == 2, data
    assert data['releaseBlockerCount'] == 1, data
    assert data['highValueGapCount'] == 4, data
    assert data['remainingStopJudgeCount'] == 2, data
    status = data.get('statusText') or ''
    assert 'completion: implement' in status, status
    assert 'slice fixture-status-surface' in status, status
    assert 'next completion-implementer' in status, status
    assert 'remaining 2c/1b/4g/2j' in status, status
    widget = data['widgetLines']
    assert 'phase: implement' in widget, widget
    assert 'slice: fixture-status-surface' in widget, widget
    assert 'next: completion-implementer' in widget, widget
    assert 'remaining: 2 contracts · 1 blocker · 4 gaps · 2 stop judges' in widget, widget
elif mode == 'live':
    assert data['snapshotPresent'] is True, data
    assert data['activeRole'] == 'completion-implementer', data
    assert data['livePreview'] == 'Loading canonical completion state', data
    status = data.get('statusText') or ''
    assert 'running completion-implementer' in status, status
    assert 'Loading canonical completion state' in status, status
    widget = data['widgetLines']
    assert 'active role: completion-implementer' in widget, widget
    assert 'live: Loading canonical completion state' in widget, widget
else:
    raise AssertionError(f'unknown assertion mode: {mode}')
PY
}

NO_SNAPSHOT_ROOT="$TMPDIR/no-snapshot"
mkdir -p "$NO_SNAPSHOT_ROOT"
cd "$NO_SNAPSHOT_ROOT"
git init -q
NO_SNAPSHOT_JSON="$TMPDIR/no-snapshot-status.json"
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_STATUS_SNAPSHOT_FILE="$NO_SNAPSHOT_JSON" \
pi -e "$PKG_ROOT" -p "/complete" >/tmp/pi-completion-status-none.out 2>/tmp/pi-completion-status-none.err || true
assert_status_json "$NO_SNAPSHOT_JSON" none

FIXTURE_ROOT="$TMPDIR/fixture"
mkdir -p "$FIXTURE_ROOT/.agent"
cd "$FIXTURE_ROOT"
git init -q

cat > .agent/profile.json <<'JSON'
{
  "schema_version": 1,
  "protocol_id": "completion",
  "project_name": "status-surface-fixture",
  "required_stop_judges": 3,
  "priority_policy_id": "completion-default",
  "docs_surfaces": ["README.md"]
}
JSON

cat > .agent/state.json <<'JSON'
{
  "schema_version": 1,
  "mission_anchor": "Verify persistent completion observability status surfaces.",
  "current_phase": "implement",
  "continuation_policy": "continue",
  "continuation_reason": "Status surface regression fixture.",
  "project_done": false,
  "requires_reground": false,
  "slices_since_last_reground": 0,
  "remaining_release_blockers": 1,
  "remaining_high_value_gaps": 4,
  "unsatisfied_contract_ids": ["OBS-STATUS-SURFACE", "OBS-ACTIVITY-SEPARATION"],
  "release_blocker_ids": ["RB-STATUS-FIXTURE"],
  "next_mandatory_action": "Implement selected slice fixture-status-surface.",
  "next_mandatory_role": "completion-implementer",
  "remaining_stop_judges": 2,
  "last_reground_at": "2026-04-30T00:00:00Z",
  "last_auditor_verdict": null,
  "contract_status": "gaps_identified",
  "latest_completed_slice": null,
  "latest_verified_slice": null
}
JSON

cat > .agent/plan.json <<'JSON'
{
  "schema_version": 1,
  "mission_anchor": "Verify persistent completion observability status surfaces.",
  "last_reground_at": "2026-04-30T00:00:00Z",
  "plan_basis": "observability_status_fixture",
  "candidate_slices": [
    {
      "slice_id": "fixture-status-surface",
      "goal": "Render a persistent completion status surface from canonical state.",
      "acceptance_criteria": [
        "Persistent status text is rendered.",
        "Persistent widget lines are rendered."
      ],
      "contract_ids": ["OBS-STATUS-SURFACE"],
      "priority": 100,
      "status": "selected",
      "why_now": "Fixture for observability status regression coverage.",
      "blocked_on": [],
      "evidence": []
    }
  ]
}
JSON

cat > .agent/active-slice.json <<'JSON'
{
  "schema_version": 1,
  "mission_anchor": "Verify persistent completion observability status surfaces.",
  "status": "selected",
  "slice_id": "fixture-status-surface",
  "goal": "Render a persistent completion status surface from canonical state.",
  "contract_ids": ["OBS-STATUS-SURFACE"],
  "acceptance_criteria": [
    "Persistent status text is rendered.",
    "Persistent widget lines are rendered."
  ],
  "blocked_on": [],
  "locked_notes": [],
  "must_fix_findings": [],
  "basis_commit": "fixturebasis",
  "remaining_contract_ids_before": ["OBS-STATUS-SURFACE", "OBS-ACTIVITY-SEPARATION"],
  "release_blocker_count_before": 1,
  "high_value_gap_count_before": 4,
  "priority": 100,
  "why_now": "Fixture for observability status regression coverage."
}
JSON

STATIC_JSON="$TMPDIR/static-status.json"
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_STATUS_SNAPSHOT_FILE="$STATIC_JSON" \
pi -e "$PKG_ROOT" -p "/complete" >/tmp/pi-completion-status-static.out 2>/tmp/pi-completion-status-static.err
assert_status_json "$STATIC_JSON" static

LIVE_JSON="$TMPDIR/live-status.json"
PI_COMPLETION_SKIP_DRIVER_KICKOFF=1 \
PI_COMPLETION_STATUS_SNAPSHOT_FILE="$LIVE_JSON" \
PI_COMPLETION_TEST_LIVE_ROLE_ACTIVITY_JSON='{"role":"completion-implementer","status":"running","progress":"Loading canonical completion state","currentAction":"read .agent/state.json","recentActivity":["Starting role subprocess","read .agent/state.json"],"startedAt":1000,"updatedAt":2000}' \
pi -e "$PKG_ROOT" -p "/complete" >/tmp/pi-completion-status-live.out 2>/tmp/pi-completion-status-live.err
assert_status_json "$LIVE_JSON" live

echo "observability status test passed: $TMPDIR"
