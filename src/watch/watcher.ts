import { open, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PipelineEvent } from '../events/schema.js';

export interface WatchOptions {
  taskSlug: string;
  caseRoot: string;
  runId?: string;
  format?: 'structured' | 'raw';
  pollIntervalMs?: number;
}

const MILESTONE_EVENTS = new Set([
  'phase_start',
  'phase_end',
  'revision_requested',
  'revision_budget_exhausted',
  'status_changed',
  'pipeline_start',
  'pipeline_end',
  'tool_start',
  'tool_end',
]);

export async function* watchEventLog(options: WatchOptions): AsyncGenerator<PipelineEvent> {
  const { taskSlug, caseRoot, format = 'structured', pollIntervalMs = 250 } = options;

  const filePath = await resolveEventLogPath(caseRoot, taskSlug, options.runId);

  // Wait for file to appear with exponential backoff
  let waited = 0;
  const maxWait = 10000;
  let delay = 100;
  while (waited < maxWait) {
    try {
      await stat(filePath);
      break;
    } catch {
      await sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, 2000);
    }
  }

  let offset = 0;
  let remainder = '';

  // Initial read: replay existing events
  const initial = await readFromOffset(filePath, offset);
  if (initial) {
    const { lines, leftover } = parseLines(initial.data, remainder);
    offset = initial.bytesRead + offset;
    remainder = leftover;

    for (const line of lines) {
      const event = parseLine(line);
      if (event && shouldYield(event, format)) yield event;
      if (event?.event === 'pipeline_end') return;
    }
    offset = initial.bytesRead;
  }

  // Tail loop
  while (true) {
    await sleep(pollIntervalMs);

    const chunk = await readFromOffset(filePath, offset);
    if (!chunk || chunk.data.length === 0) continue;

    const { lines, leftover } = parseLines(chunk.data, remainder);
    offset += chunk.bytesRead;
    remainder = leftover;

    for (const line of lines) {
      const event = parseLine(line);
      if (event && shouldYield(event, format)) yield event;
      if (event?.event === 'pipeline_end') return;
    }
  }
}

async function resolveEventLogPath(caseRoot: string, taskSlug: string, runId?: string): Promise<string> {
  const eventDir = resolve(caseRoot, '.case', taskSlug, 'events');

  if (runId) {
    return resolve(eventDir, `run-${runId}.jsonl`);
  }

  // Find latest .jsonl by mtime
  try {
    const files = await readdir(eventDir);
    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) {
      return resolve(eventDir, 'run-latest.jsonl');
    }

    let latest = jsonlFiles[0];
    let latestMtime = 0;
    for (const file of jsonlFiles) {
      const s = await stat(resolve(eventDir, file));
      if (s.mtimeMs > latestMtime) {
        latestMtime = s.mtimeMs;
        latest = file;
      }
    }
    return resolve(eventDir, latest);
  } catch {
    return resolve(eventDir, 'run-latest.jsonl');
  }
}

async function readFromOffset(filePath: string, offset: number): Promise<{ data: string; bytesRead: number } | null> {
  try {
    const fh = await open(filePath, 'r');
    try {
      const fileStat = await fh.stat();
      if (fileStat.size <= offset) return null;

      const buf = Buffer.alloc(fileStat.size - offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      return { data: buf.toString('utf-8', 0, bytesRead), bytesRead };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

function parseLines(data: string, remainder: string): { lines: string[]; leftover: string } {
  const combined = remainder + data;
  const parts = combined.split('\n');

  // Last element is either empty (data ended with \n) or an incomplete line
  const leftover = parts.pop() ?? '';
  const lines = parts.filter((l) => l.trim().length > 0);

  return { lines, leftover };
}

function parseLine(line: string): PipelineEvent | null {
  try {
    return JSON.parse(line) as PipelineEvent;
  } catch {
    return null;
  }
}

function shouldYield(event: PipelineEvent, format: 'structured' | 'raw'): boolean {
  if (format === 'raw') return true;
  return MILESTONE_EVENTS.has(event.event);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
