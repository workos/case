/**
 * Thin wrapper around the `td` CLI (marcus/td) — the task store for Case.
 *
 * Case used to persist each task as a `.case/tasks/active/<id>.task.json`
 * (machine state) plus a `<id>.md` (human spec). Both are now replaced by a
 * single `td` issue per task, stored in the target repo's `.todos/` SQLite db:
 *
 *   - td `title`        ← task title
 *   - td `acceptance`   ← acceptance criteria text
 *   - td `status`       ← best-effort mirror of the Case status (human/td-CLI
 *                          visibility only — see {@link caseToTdStatus})
 *   - td `labels`       ← `caseid:<id>`, `repo:<name>`, `issuetype:<t>`,
 *                          and `issue:<n>` when the task tracks an issue
 *   - td `description`  ← the human-readable spec markdown, followed by a
 *                          hidden `<!-- case-state {json} -->` comment holding
 *                          the authoritative {@link TaskJson}.
 *
 * The hidden comment is what makes a round-trip lossless: Case's status enum
 * (`active`/`implementing`/.../`merged`), the per-agent phase map, and the
 * pending revision are all finer-grained than anything td models natively, so
 * the full `TaskJson` rides along as JSON. td's native fields are a projection
 * for humans and `td` tooling; the comment is the source of truth.
 *
 * Execution state (the JSONL event log, plan.json, metrics) is unaffected — it
 * still lives under `<repo>/.case/<taskId>/` and was never "task management".
 */
import type { TaskJson } from '../types.js';

export class TdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TdError';
  }
}

const CASE_STATE_OPEN = '<!-- case-state';
const CASE_STATE_CLOSE = '-->';

// --- description codec ---------------------------------------------------

/**
 * Compose a td `description` from the human spec and the authoritative task
 * state. The state is embedded as a trailing HTML comment so it is invisible
 * when the spec is rendered (`td show -m`) but survives a JSON round-trip.
 */
export function encodeDescription(spec: string, task: TaskJson): string {
  const body = spec.trimEnd();
  const state = `${CASE_STATE_OPEN}\n${JSON.stringify(task)}\n${CASE_STATE_CLOSE}`;
  return body.length > 0 ? `${body}\n\n${state}\n` : `${state}\n`;
}

/** Extract the embedded {@link TaskJson} from a td description. */
export function decodeState(description: string): TaskJson | null {
  const start = description.indexOf(CASE_STATE_OPEN);
  if (start === -1) return null;
  const end = description.indexOf(CASE_STATE_CLOSE, start + CASE_STATE_OPEN.length);
  if (end === -1) return null;
  const json = description.slice(start + CASE_STATE_OPEN.length, end).trim();
  try {
    return JSON.parse(json) as TaskJson;
  } catch {
    return null;
  }
}

/** Strip the embedded state comment, returning just the human spec markdown. */
export function extractSpec(description: string): string {
  const start = description.indexOf(CASE_STATE_OPEN);
  if (start === -1) return description.trimEnd();
  return description.slice(0, start).trimEnd();
}

// --- status / label mapping ----------------------------------------------

/** Map a Case status onto the nearest native td lifecycle status. */
export function caseToTdStatus(status: TaskJson['status']): string {
  switch (status) {
    case 'active':
      return 'open';
    case 'pr-opened':
      return 'in_review';
    case 'merged':
      return 'closed';
    default:
      // implementing / verifying / reviewing / evaluating / closing
      return 'in_progress';
  }
}

/** Build the canonical label set Case stamps on every td issue. */
export function buildLabels(task: Pick<TaskJson, 'id' | 'repo' | 'issue' | 'issueType'>): string[] {
  const labels = [`caseid:${task.id}`, `repo:${task.repo}`];
  if (task.issueType) labels.push(`issuetype:${task.issueType}`);
  if (task.issue) labels.push(`issue:${task.issue}`);
  return labels;
}

// --- raw td issue shape (subset we read) ---------------------------------

export interface TdIssue {
  id: string;
  title: string;
  description: string;
  acceptance: string;
  status: string;
  labels: string[];
}

// --- CLI invocation ------------------------------------------------------

/**
 * Invoke `td` directly via Bun.spawn rather than through the shared
 * `runCommand` util. `td` is the task store under test, so it must reach the
 * real binary even in unit tests (where `runCommand` is mocked to block process
 * execution). `-w` resolves the repo's `.todos` database; `TD_NO_UPDATE_CHECK`
 * suppresses the "update available" banner that would corrupt parsed output.
 */
async function td(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(['td', '-w', repoPath, ...args], {
      cwd: repoPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, TD_NO_UPDATE_CHECK: '1' },
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } catch (err) {
    return { stdout: '', stderr: (err as Error).message ?? String(err), exitCode: 1 };
  }
}

/** Ensure a td database exists for the repo. Idempotent. */
export async function ensureTd(repoPath: string): Promise<void> {
  const probe = await td(repoPath, ['list', '--json', '-n', '1']);
  if (probe.exitCode === 0) return;
  if (/database not found/i.test(probe.stderr) || /run 'td init'/i.test(probe.stderr)) {
    const init = await td(repoPath, ['init']);
    if (init.exitCode !== 0) throw new TdError(`td init failed: ${init.stderr.trim()}`);
    return;
  }
  throw new TdError(`td unavailable in ${repoPath}: ${probe.stderr.trim()}`);
}

export interface TdCreateInput {
  title: string;
  description: string;
  acceptance: string;
  labels: string[];
  type?: string;
}

/** Create a td issue and return its td handle (e.g. `td-a1b2c3`). */
export async function tdCreate(repoPath: string, input: TdCreateInput): Promise<string> {
  await ensureTd(repoPath);
  const args = ['create', input.title, '--description', input.description, '--type', input.type ?? 'task'];
  if (input.acceptance) args.push('--acceptance', input.acceptance);
  if (input.labels.length > 0) args.push('--labels', input.labels.join(','));

  const res = await td(repoPath, args);
  if (res.exitCode !== 0) throw new TdError(`td create failed: ${res.stderr.trim() || res.stdout.trim()}`);
  const match = res.stdout.match(/td-[0-9a-z]+/);
  if (!match) throw new TdError(`td create produced no issue id: ${res.stdout.trim()}`);
  return match[0];
}

function parseIssue(raw: unknown): TdIssue | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string') return null;
  return {
    id: o.id,
    title: typeof o.title === 'string' ? o.title : '',
    description: typeof o.description === 'string' ? o.description : '',
    acceptance: typeof o.acceptance === 'string' ? o.acceptance : '',
    status: typeof o.status === 'string' ? o.status : '',
    labels: Array.isArray(o.labels) ? (o.labels.filter((l) => typeof l === 'string') as string[]) : [],
  };
}

/** Fetch a single td issue by its td handle, or null if not found. */
export async function tdShow(repoPath: string, tdId: string): Promise<TdIssue | null> {
  const res = await td(repoPath, ['show', tdId, '--json']);
  if (res.exitCode !== 0) return null;
  try {
    const data = JSON.parse(res.stdout);
    return parseIssue(data);
  } catch {
    return null;
  }
}

/** List td issues, optionally filtered by labels. Includes closed/deferred. */
export async function tdList(repoPath: string, labels?: string[]): Promise<TdIssue[]> {
  const args = ['list', '--json', '-a', '-n', '500'];
  for (const label of labels ?? []) args.push('--labels', label);
  const res = await td(repoPath, args);
  if (res.exitCode !== 0) return [];
  try {
    const data = JSON.parse(res.stdout);
    if (!Array.isArray(data)) return [];
    return data.map(parseIssue).filter((i): i is TdIssue => i !== null);
  } catch {
    return [];
  }
}

export interface TdUpdateInput {
  description?: string;
  acceptance?: string;
  status?: string;
  labels?: string[];
  comment?: string;
  title?: string;
}

/** Update fields on a td issue. `labels` replaces the full label set. */
export async function tdUpdate(repoPath: string, tdId: string, fields: TdUpdateInput): Promise<void> {
  const args = ['update', tdId];
  if (fields.title !== undefined) args.push('--title', fields.title);
  if (fields.description !== undefined) args.push('--description', fields.description);
  if (fields.acceptance !== undefined) args.push('--acceptance', fields.acceptance);
  if (fields.status !== undefined) args.push('--status', fields.status);
  if (fields.labels !== undefined) args.push('--labels', fields.labels.join(','));
  if (fields.comment !== undefined) args.push('--comment', fields.comment);
  if (args.length === 2) return; // nothing to update
  const res = await td(repoPath, args);
  if (res.exitCode !== 0) throw new TdError(`td update failed: ${res.stderr.trim() || res.stdout.trim()}`);
}

/** Set the focused/current task for the repo (replaces the old .case/active marker). */
export async function tdFocus(repoPath: string, tdId: string): Promise<void> {
  const res = await td(repoPath, ['focus', tdId]);
  if (res.exitCode !== 0) throw new TdError(`td focus failed: ${res.stderr.trim()}`);
}

/** Return the td handle of the currently focused task, or null. */
export async function tdCurrent(repoPath: string): Promise<string | null> {
  const res = await td(repoPath, ['current', '--json']);
  if (res.exitCode !== 0) return null;
  try {
    const data = JSON.parse(res.stdout) as { focused?: { issue?: { id?: string } } };
    return data.focused?.issue?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the repo's focused task to its td handle and decoded {@link TaskJson}.
 * Returns null when nothing is focused or the focused issue lacks case-state.
 * This is the `td` replacement for reading the old `.case/active` marker.
 */
export async function resolveFocusedTask(repoPath: string): Promise<{ tdId: string; task: TaskJson } | null> {
  const tdId = await tdCurrent(repoPath);
  if (!tdId) return null;
  const issue = await tdShow(repoPath, tdId);
  if (!issue) return null;
  const task = decodeState(issue.description);
  if (!task) return null;
  return { tdId, task: { ...task, tdId } };
}
