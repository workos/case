import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PipelineEvent, PipelineEventInput } from './schema.js';
import type { PipelineState } from './types.js';
import { validateTransition } from './errors.js';
import { applyEvent } from './reducer.js';

/**
 * Write-only JSONL event sink + in-memory `PipelineState` container. Phase 1.3
 * relocated the td-mirror + marker projections out of `append()` to node-direct
 * writes in the LangGraph engine (see `langgraph/projection.ts`); the raw log
 * stays as the observability sink until it is deleted in Phase 2.2. `getState()`
 * still backs metrics and the retrospective snapshot.
 */
export class EventAppender {
  private readonly filePath: string;
  private readonly runId: string;
  private state: PipelineState | null = null;
  private sequence = 0;
  private dirReady: Promise<void> | null = null;

  constructor(caseRoot: string, taskSlug: string, runId: string) {
    this.runId = runId;
    const eventDir = resolve(caseRoot, '.case', taskSlug, 'events');
    this.filePath = resolve(eventDir, `run-${runId}.jsonl`);
    this.dirReady = mkdir(eventDir, { recursive: true }).then(() => {});
  }

  async append(partial: PipelineEventInput): Promise<void> {
    const event = {
      ...partial,
      ts: new Date().toISOString(),
      sequence: ++this.sequence,
      runId: this.runId,
    } as PipelineEvent;

    validateTransition(event, this.state);

    if (this.dirReady) {
      await this.dirReady;
      this.dirReady = null;
    }

    await appendFile(this.filePath, JSON.stringify(event) + '\n');

    this.state = applyEvent(this.state, event);
  }

  getState(): PipelineState {
    if (!this.state) throw new Error('No events appended yet');
    return this.state;
  }

  get path(): string {
    return this.filePath;
  }
}
