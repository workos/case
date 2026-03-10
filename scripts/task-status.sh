#!/usr/bin/env bash
# task-status.sh — Read/update fields in .task.json companion files
#
# Usage:
#   task-status.sh <task.json> status                          # read status
#   task-status.sh <task.json> status implementing             # set status (validates transition)
#   task-status.sh <task.json> agent orchestrator started      # set agent phase
#   task-status.sh <task.json> prUrl <url>                     # set PR URL
#   task-status.sh <task.json> id                              # read task id
#   task-status.sh <task.json> tested true --from-marker       # ONLY callable by marker scripts
#   task-status.sh <task.json> manualTested true --from-marker # ONLY callable by marker scripts
#
# Note: tested and manualTested reject writes without --from-marker.
# These fields are owned by mark-tested.sh and mark-manual-tested.sh.

set -uo pipefail

TASK_FILE="${1:-}"
FIELD="${2:-}"
VALUE="${3:-}"
EXTRA="${4:-}"

if [[ -z "$TASK_FILE" || -z "$FIELD" ]]; then
  echo "Usage: task-status.sh <task.json> <field> [value] [--from-marker]" >&2
  echo "" >&2
  echo "Fields: status, id, repo, issue, issueType, branch, tested, manualTested, prUrl, prNumber, contractPath" >&2
  echo "Special: agent <name> <started|completed|status> [value]" >&2
  exit 1
fi

if [[ ! -f "$TASK_FILE" ]]; then
  echo "Error: task file not found: $TASK_FILE" >&2
  exit 1
fi

# --- Read mode (no value provided) ---
if [[ -z "$VALUE" && "$FIELD" != "agent" ]]; then
  TS_FILE="$TASK_FILE" TS_FIELD="$FIELD" python3 -c "
import json, os, sys
with open(os.environ['TS_FILE']) as f:
    data = json.load(f)
val = data.get(os.environ['TS_FIELD'])
if val is None:
    print('null')
elif isinstance(val, bool):
    print(str(val).lower())
elif isinstance(val, (dict, list)):
    print(json.dumps(val))
else:
    print(val)
"
  exit $?
fi

# --- Agent phase mode ---
if [[ "$FIELD" == "agent" ]]; then
  AGENT_NAME="$VALUE"
  AGENT_FIELD="${EXTRA:-}"
  AGENT_VALUE="${5:-}"

  if [[ -z "$AGENT_NAME" || -z "$AGENT_FIELD" ]]; then
    echo "Usage: task-status.sh <task.json> agent <name> <started|completed|status> [value]" >&2
    exit 1
  fi

  # Read mode for agent field
  if [[ -z "$AGENT_VALUE" ]]; then
    TS_FILE="$TASK_FILE" TS_AGENT="$AGENT_NAME" TS_AFIELD="$AGENT_FIELD" python3 -c "
import json, os
with open(os.environ['TS_FILE']) as f:
    data = json.load(f)
agents = data.get('agents', {})
phase = agents.get(os.environ['TS_AGENT'], {})
val = phase.get(os.environ['TS_AFIELD'])
print('null' if val is None else val)
"
    exit $?
  fi

  # Write mode for agent field — auto-timestamp for started/completed
  TS_FILE="$TASK_FILE" TS_AGENT="$AGENT_NAME" TS_AFIELD="$AGENT_FIELD" TS_AVALUE="$AGENT_VALUE" python3 -c "
import json, os, sys
from datetime import datetime, timezone

task_file = os.environ['TS_FILE']
agent_name = os.environ['TS_AGENT']
field = os.environ['TS_AFIELD']
value = os.environ['TS_AVALUE']

with open(task_file) as f:
    data = json.load(f)

agents = data.setdefault('agents', {})
phase = agents.setdefault(agent_name, {})

if field in ('started', 'completed'):
    if value == 'now':
        value = datetime.now(timezone.utc).isoformat()
    phase[field] = value
elif field == 'status':
    valid = ['pending', 'running', 'completed', 'failed']
    if value not in valid:
        print(f'Error: invalid agent status \"{value}\". Must be one of: {valid}', file=sys.stderr)
        sys.exit(1)
    phase[field] = value
else:
    print(f'Error: invalid agent field \"{field}\". Must be: started, completed, status', file=sys.stderr)
    sys.exit(1)

with open(task_file, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
print(f'OK: agents.{agent_name}.{field} = {value}')
"
  exit $?
fi

# --- Evidence flag guard ---
if [[ "$FIELD" == "tested" || "$FIELD" == "manualTested" ]]; then
  FROM_MARKER="${EXTRA:-}"
  if [[ "$FROM_MARKER" != "--from-marker" ]]; then
    echo "Error: $FIELD can only be set by marker scripts (pass --from-marker)" >&2
    echo "Use mark-tested.sh or mark-manual-tested.sh instead." >&2
    exit 1
  fi
fi

# --- Status transition validation ---
if [[ "$FIELD" == "status" ]]; then
  TS_FILE="$TASK_FILE" TS_VALUE="$VALUE" python3 -c "
import json, os, sys

TRANSITIONS = {
    'active': ['implementing'],
    'implementing': ['verifying', 'active'],
    'verifying': ['reviewing', 'closing', 'implementing'],
    'reviewing': ['closing', 'verifying'],
    'closing': ['pr-opened', 'verifying'],
    'pr-opened': ['pr-opened', 'merged'],
    'merged': [],
}

task_file = os.environ['TS_FILE']
target = os.environ['TS_VALUE']

with open(task_file) as f:
    data = json.load(f)

current = data.get('status', 'active')

if target not in TRANSITIONS.get(current, []):
    allowed = TRANSITIONS.get(current, [])
    print(f'Error: invalid transition {current} → {target}. Allowed from {current}: {allowed}', file=sys.stderr)
    sys.exit(1)

data['status'] = target

with open(task_file, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
print(f'OK: status {current} → {target}')
"
  exit $?
fi

# --- Generic field write ---
TS_FILE="$TASK_FILE" TS_FIELD="$FIELD" TS_VALUE="$VALUE" python3 -c "
import json, os, sys

task_file = os.environ['TS_FILE']
field = os.environ['TS_FIELD']
value = os.environ['TS_VALUE']

with open(task_file) as f:
    data = json.load(f)

# Type coercion
if value == 'true':
    value = True
elif value == 'false':
    value = False
elif value == 'null':
    value = None
else:
    try:
        value = int(value)
    except ValueError:
        pass  # keep as string

readonly = ('id', 'created')
if field in readonly:
    print(f'Error: field \"{field}\" is read-only', file=sys.stderr)
    sys.exit(1)

known = ('prUrl', 'prNumber', 'tested', 'manualTested', 'issue', 'issueType', 'branch', 'contractPath')
if field not in data and field not in known:
    print(f'Error: unknown field \"{field}\"', file=sys.stderr)
    sys.exit(1)

data[field] = value

with open(task_file, 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
print(f'OK: {field} = {value}')
"
exit $?
