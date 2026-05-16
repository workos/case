import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * @deprecated Use EventAppender from src/events/appender.ts instead.
 * Retained for backward compat with tool-level tracing in the Pi adapter.
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

  write(event: Record<string, unknown>): void {
    this.buffer.push(JSON.stringify(event));
  }

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

  get path(): string {
    return this.filePath;
  }
}
