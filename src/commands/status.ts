import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { TaskStatus } from '../types.js';

export const description = 'Read or update the current task status';

const TRANSITIONS: Record<string, TaskStatus[]> = {
  active: ['implementing'],
  implementing: ['verifying', 'active'],
  verifying: ['reviewing', 'evaluating', 'closing', 'implementing'],
  reviewing: ['evaluating', 'closing', 'verifying'],
  evaluating: ['closing', 'implementing', 'verifying', 'reviewing'],
  closing: ['pr-opened', 'verifying'],
  'pr-opened': ['pr-opened', 'merged'],
  merged: [],
};

const VALID_AGENT_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
const READONLY_FIELDS = new Set(['id', 'created']);
const KNOWN_FIELDS = new Set([
  'prUrl',
  'prNumber',
  'tested',
  'manualTested',
  'issue',
  'issueType',
  'branch',
  'contractPath',
  'checkCommand',
  'checkBaseline',
  'checkTarget',
  'mode',
]);

function readTask(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeTask(path: string, data: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function printValue(val: unknown): void {
  if (val === undefined || val === null) process.stdout.write('null\n');
  else if (typeof val === 'boolean') process.stdout.write(`${val}\n`);
  else if (typeof val === 'object') process.stdout.write(JSON.stringify(val) + '\n');
  else process.stdout.write(`${val}\n`);
}

function coerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const num = Number(value);
  if (Number.isInteger(num) && String(num) === value) return num;
  return value;
}

export async function handler(argv: string[]): Promise<number> {
  const taskFile = argv[0];
  const field = argv[1];
  const value = argv[2];
  const extra = argv[3];

  if (!taskFile || !field) {
    process.stderr.write(
      'Usage: ca status <task.json> <field> [value] [--from-marker]\n\n' +
        'Fields: status, id, repo, issue, issueType, branch, tested, manualTested, prUrl, prNumber, contractPath\n' +
        'Special: agent <name> <started|completed|status> [value]\n',
    );
    return 1;
  }

  if (!existsSync(taskFile)) {
    process.stderr.write(`Error: task file not found: ${taskFile}\n`);
    return 1;
  }

  // Read mode
  if (value === undefined && field !== 'agent') {
    printValue(readTask(taskFile)[field]);
    return 0;
  }

  // Agent phase mode
  if (field === 'agent') {
    const agentName = value;
    const agentField = extra;
    const agentValue = argv[4];
    if (!agentName || !agentField) {
      process.stderr.write('Usage: ca status <task.json> agent <name> <started|completed|status> [value]\n');
      return 1;
    }
    const data = readTask(taskFile);
    const agents = (data.agents ?? {}) as Record<string, Record<string, unknown>>;
    if (agentValue === undefined) {
      printValue((agents[agentName] ?? {})[agentField]);
      return 0;
    }
    if (!agents[agentName]) agents[agentName] = {};
    const phase = agents[agentName]!;
    if (agentField === 'started' || agentField === 'completed') {
      phase[agentField] = agentValue === 'now' ? new Date().toISOString() : agentValue;
    } else if (agentField === 'status') {
      if (!(VALID_AGENT_STATUSES as readonly string[]).includes(agentValue)) {
        process.stderr.write(
          `Error: invalid agent status "${agentValue}". Must be one of: ${VALID_AGENT_STATUSES.join(', ')}\n`,
        );
        return 1;
      }
      phase.status = agentValue;
    } else {
      process.stderr.write(`Error: invalid agent field "${agentField}". Must be: started, completed, status\n`);
      return 1;
    }
    data.agents = agents;
    writeTask(taskFile, data);
    process.stdout.write(`OK: agents.${agentName}.${agentField} = ${agentValue}\n`);
    return 0;
  }

  // Evidence flag guard
  if ((field === 'tested' || field === 'manualTested') && extra !== '--from-marker') {
    process.stderr.write(
      `Error: ${field} can only be set by marker commands (pass --from-marker)\nUse ca mark-tested or ca mark-manual-tested instead.\n`,
    );
    return 1;
  }

  // Status transition validation
  if (field === 'status') {
    const data = readTask(taskFile);
    const current = (data.status as string) ?? 'active';
    const allowed = TRANSITIONS[current] ?? [];
    if (!allowed.includes(value as TaskStatus)) {
      process.stderr.write(
        `Error: invalid transition ${current} → ${value}. Allowed from ${current}: [${allowed.join(', ')}]\n`,
      );
      return 1;
    }
    data.status = value;
    writeTask(taskFile, data);
    process.stdout.write(`OK: status ${current} → ${value}\n`);
    return 0;
  }

  // Generic field write
  const data = readTask(taskFile);
  if (READONLY_FIELDS.has(field)) {
    process.stderr.write(`Error: field "${field}" is read-only\n`);
    return 1;
  }
  if (!(field in data) && !KNOWN_FIELDS.has(field)) {
    process.stderr.write(`Error: unknown field "${field}"\n`);
    return 1;
  }
  data[field] = coerce(value);
  writeTask(taskFile, data);
  process.stdout.write(`OK: ${field} = ${value}\n`);
  return 0;
}

export { TRANSITIONS };
