import type { RevisionRequest, TaskJson } from '../types.js';
import {
  buildLabels,
  caseToTdStatus,
  decodeState,
  encodeDescription,
  extractSpec,
  tdShow,
  tdUpdate,
} from './td-client.js';

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskStateError';
  }
}

/**
 * Read/write a single task's state, backed by a `td` issue (see td-client.ts).
 *
 * The authoritative {@link TaskJson} rides inside the td issue's description as
 * a hidden `<!-- case-state {json} -->` comment; the human spec precedes it and
 * is preserved verbatim across writes. Every mutation rewrites that comment and
 * mirrors the coarse status onto td's native `status` field for visibility.
 */
export class TaskStore {
  private readonly repoPath: string;
  private readonly tdId: string;

  /** @param repoPath target repo whose `.todos/` db holds the issue. @param tdId td issue handle. */
  constructor(repoPath: string, tdId: string) {
    this.repoPath = repoPath;
    this.tdId = tdId;
  }

  async read(): Promise<TaskJson> {
    const issue = await tdShow(this.repoPath, this.tdId);
    if (!issue) throw new TaskStateError(`td issue not found: ${this.tdId}`);
    const state = decodeState(issue.description);
    if (!state) throw new TaskStateError(`td issue ${this.tdId} has no case-state payload`);
    // td's native fields are authoritative for the spec/acceptance the agents
    // edited; the embedded state owns everything else.
    return { ...state, tdId: issue.id };
  }

  async setField(field: string, value: string): Promise<void> {
    const task = await this.read();
    if (field === 'id' || field === 'created') throw new TaskStateError(`Field "${field}" is read-only`);
    let coerced: unknown = value;
    if (value === 'true') coerced = true;
    else if (value === 'false') coerced = false;
    else if (value === 'null') coerced = null;
    else {
      const n = Number(value);
      if (Number.isInteger(n) && String(n) === value) coerced = n;
    }
    (task as unknown as Record<string, unknown>)[field] = coerced;
    await this.write(task);
  }

  async writeFromProjection(projected: Partial<TaskJson>): Promise<void> {
    const task = await this.read();
    Object.assign(task, projected);
    await this.write(task);
  }

  async setPendingRevision(revision: RevisionRequest | null): Promise<void> {
    const task = await this.read();
    if (revision) task.pendingRevision = revision;
    else delete task.pendingRevision;
    await this.write(task);
  }

  /** Persist the full task state back into the td issue (state comment + native mirror). */
  private async write(task: TaskJson): Promise<void> {
    const issue = await tdShow(this.repoPath, this.tdId);
    const spec = issue ? extractSpec(issue.description) : '';
    await tdUpdate(this.repoPath, this.tdId, {
      description: encodeDescription(spec, task),
      status: caseToTdStatus(task.status),
      labels: buildLabels(task),
    });
  }
}
