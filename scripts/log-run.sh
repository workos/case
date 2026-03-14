#!/usr/bin/env bash
# log-run.sh — Append a structured entry to docs/run-log.jsonl after each pipeline run
#
# Usage:
#   log-run.sh <task.json> <outcome> [failed-agent]
#
# Arguments:
#   task.json    — path to the .task.json file
#   outcome      — "completed" | "failed"
#   failed-agent — which agent failed (only when outcome=failed)
#
# Appends one JSON line to $CASE_ROOT/docs/run-log.jsonl

set -uo pipefail

TASK_FILE="${1:-}"
OUTCOME="${2:-}"
FAILED_AGENT="${3:-}"

if [[ -z "$TASK_FILE" || -z "$OUTCOME" ]]; then
  echo "Usage: log-run.sh <task.json> <outcome> [failed-agent]" >&2
  exit 1
fi

if [[ ! -f "$TASK_FILE" ]]; then
  echo "Error: task file not found: $TASK_FILE" >&2
  exit 1
fi

CASE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$CASE_ROOT/docs/run-log.jsonl"

TS_FILE="$TASK_FILE" TS_OUTCOME="$OUTCOME" TS_FAILED="$FAILED_AGENT" TS_LOG="$LOG_FILE" python3 -c "
import json, os, sys, uuid
from datetime import datetime, timezone

task_file = os.environ['TS_FILE']
outcome = os.environ['TS_OUTCOME']
failed_agent = os.environ.get('TS_FAILED', '') or None
log_file = os.environ['TS_LOG']

with open(task_file) as f:
    data = json.load(f)

# Build phases summary from agent data
phases = {}
for agent_name in ('orchestrator', 'implementer', 'verifier', 'reviewer', 'closer'):
    agent = data.get('agents', {}).get(agent_name, {})
    status = agent.get('status', 'pending')
    if status != 'pending':
        phases[agent_name] = status

# Calculate duration if orchestrator started and last agent has a timestamp
started = data.get('agents', {}).get('orchestrator', {}).get('started')
last_completed = None
for agent_name in ('closer', 'reviewer', 'verifier', 'implementer', 'orchestrator'):
    ts = data.get('agents', {}).get(agent_name, {}).get('completed')
    if ts:
        last_completed = ts
        break

duration_min = None
if started and last_completed:
    try:
        t0 = datetime.fromisoformat(started)
        t1 = datetime.fromisoformat(last_completed)
        duration_min = round((t1 - t0).total_seconds() / 60, 1)
    except (ValueError, TypeError):
        pass

entry = {
    'runId': str(uuid.uuid4()),
    'date': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
    'task': data.get('id', 'unknown'),
    'repo': data.get('repo', 'unknown'),
    'outcome': outcome,
    'failedAgent': failed_agent,
    'phases': phases,
    'metrics': {
        'tested': data.get('tested', False),
        'manualTested': data.get('manualTested', False),
        'durationMin': duration_min,
    },
}

with open(log_file, 'a') as f:
    f.write(json.dumps(entry, separators=(',', ':')) + '\n')

print(f'OK: logged run {entry[\"runId\"][:8]} for {entry[\"task\"]} → {outcome}')
"
exit $?
