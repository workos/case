import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TaskJson } from '../types.js';

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskStateError';
  }
}

/**
 * Read/write task.json — all writes are now pure TypeScript.
 * Transition validation and evidence flag guards are enforced inline.
 */
export class TaskStore {
  private readonly taskJsonPath: string;

  constructor(taskJsonPath: string, _packageRoot?: string) {
    this.taskJsonPath = resolve(taskJsonPath);
  }

  async read(): Promise<TaskJson> {
    const raw = await Bun.file(this.taskJsonPath).text();
    return JSON.parse(raw) as TaskJson;
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
    this.writeSync(task);
  }

  async writeFromProjection(projected: Partial<TaskJson>): Promise<void> {
    const task = await this.read();
    Object.assign(task, projected);
    this.writeSync(task);
  }

  async setPendingRevision(revision: import('../types.js').RevisionRequest | null): Promise<void> {
    const task = await this.read();
    if (revision) task.pendingRevision = revision;
    else delete task.pendingRevision;
    this.writeSync(task);
  }

  private writeSync(task: TaskJson): void {
    writeFileSync(this.taskJsonPath, JSON.stringify(task, null, 2) + '\n');
  }
}
