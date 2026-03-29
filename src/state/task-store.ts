import { resolve } from 'node:path';
import type { AgentName, TaskJson, TaskStatus } from '../types.js';
import { runScript } from '../util/run-script.js';

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskStateError';
  }
}

/**
 * Read/write task.json — delegates all writes to task-status.sh
 * to preserve transition validation and evidence flag guards.
 */
export class TaskStore {
  private readonly taskJsonPath: string;
  private readonly taskStatusScript: string;

  constructor(taskJsonPath: string, caseRoot: string) {
    this.taskJsonPath = resolve(taskJsonPath);
    this.taskStatusScript = resolve(caseRoot, 'scripts/task-status.sh');
  }

  /** Read and parse the task JSON file directly (faster than script). */
  async read(): Promise<TaskJson> {
    const raw = await Bun.file(this.taskJsonPath).text();
    return JSON.parse(raw) as TaskJson;
  }

  async readStatus(): Promise<TaskStatus> {
    const task = await this.read();
    return task.status;
  }

  /** Set task status — validates transition via task-status.sh. No-op if already at target. */
  async setStatus(status: TaskStatus): Promise<void> {
    const current = await this.readStatus();
    if (current === status) return;

    const result = await runScript('bash', [this.taskStatusScript, this.taskJsonPath, 'status', status]);

    if (result.exitCode !== 0) {
      throw new TaskStateError(result.stderr.trim() || `Failed to set status to ${status}`);
    }
  }

  /** Set an agent phase field (status, started, completed). */
  async setAgentPhase(agent: AgentName, field: 'status' | 'started' | 'completed', value: string): Promise<void> {
    const result = await runScript('bash', [this.taskStatusScript, this.taskJsonPath, 'agent', agent, field, value]);

    if (result.exitCode !== 0) {
      throw new TaskStateError(result.stderr.trim() || `Failed to set agents.${agent}.${field} to ${value}`);
    }
  }

  /** Set a generic field (prUrl, prNumber, branch, etc). */
  async setField(field: string, value: string): Promise<void> {
    const result = await runScript('bash', [this.taskStatusScript, this.taskJsonPath, field, value]);

    if (result.exitCode !== 0) {
      throw new TaskStateError(result.stderr.trim() || `Failed to set ${field} to ${value}`);
    }
  }

  /** Persist or clear a pending revision request directly in the task JSON.
   *  Bypasses task-status.sh because that script has no subcommand for pendingRevision —
   *  this field is pipeline-internal state, not a status transition. */
  async setPendingRevision(revision: import('../types.js').RevisionRequest | null): Promise<void> {
    const task = await this.read();
    if (revision) {
      task.pendingRevision = revision;
    } else {
      delete task.pendingRevision;
    }
    await Bun.write(this.taskJsonPath, JSON.stringify(task, null, 2) + '\n');
  }
}
