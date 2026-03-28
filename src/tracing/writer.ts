import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TraceEvent } from './types.js';

/**
 * Append-only JSONL trace writer for a single pipeline run.
 *
 * Writes to: .case/<task-slug>/traces/run-<runId>.jsonl
 * One JSON line per TraceEvent — designed for `jq` and `grep` analysis.
 */
export class TraceWriter {
  private buffer: string[] = [];
  private readonly filePath: string;
  private dirReady: Promise<void> | null = null;

  constructor(caseRoot: string, taskSlug: string, runId: string) {
    const traceDir = resolve(caseRoot, '.case', taskSlug, 'traces');
    this.filePath = resolve(traceDir, `run-${runId}.jsonl`);
    this.dirReady = mkdir(traceDir, { recursive: true }).then(() => {});
  }

  /** Buffer an event. Call flush() to write to disk. */
  write(event: TraceEvent): void {
    this.buffer.push(JSON.stringify(event));
  }

  /** Flush buffered events to the trace file. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    if (this.dirReady) {
      await this.dirReady;
      this.dirReady = null;
    }
    const chunk = this.buffer.join('\n') + '\n';
    this.buffer = [];
    await appendFile(this.filePath, chunk);
  }

  /** Returns the trace file path (for logging / retrospective). */
  get path(): string {
    return this.filePath;
  }
}
