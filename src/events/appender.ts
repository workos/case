import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskStore } from '../state/task-store.js';
import type { PipelineEvent, PipelineEventInput } from './schema.js';
import type { PipelineState } from './types.js';
import { validateTransition } from './errors.js';
import { applyEvent } from './reducer.js';
import { projectTaskJson, projectMarkers } from './projections.js';

export class EventAppender {
  private readonly filePath: string;
  private readonly caseRoot: string;
  private readonly taskSlug: string;
  private readonly runId: string;
  private state: PipelineState | null = null;
  private sequence = 0;
  private dirReady: Promise<void> | null = null;

  constructor(
    caseRoot: string,
    taskSlug: string,
    runId: string,
    private readonly taskStore: TaskStore,
  ) {
    this.caseRoot = caseRoot;
    this.taskSlug = taskSlug;
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

    await this.runProjections();
  }

  getState(): PipelineState {
    if (!this.state) throw new Error('No events appended yet');
    return this.state;
  }

  get path(): string {
    return this.filePath;
  }

  restoreState(state: PipelineState): void {
    this.state = state;
    this.sequence = state.lastSequence;
  }

  private async runProjections(): Promise<void> {
    if (!this.state) return;

    const taskJson = projectTaskJson(this.state);
    await this.taskStore.writeFromProjection(taskJson);

    const markers = projectMarkers(this.state);
    for (const marker of markers) {
      if (!this.state.markers.has(marker.name)) {
        const markerPath = resolve(this.caseRoot, marker.path);
        const markerDir = resolve(markerPath, '..');
        await mkdir(markerDir, { recursive: true });
        await writeFile(markerPath, new Date().toISOString());
        this.state.markers.add(marker.name);
      }
    }

    // Re-project TaskJson now that markers are updated
    if (markers.length > 0) {
      const updatedTaskJson = projectTaskJson(this.state);
      await this.taskStore.writeFromProjection(updatedTaskJson);
    }
  }
}
