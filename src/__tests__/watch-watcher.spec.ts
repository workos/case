import { describe, test, expect, afterAll } from 'bun:test';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { watchEventLog } from '../watch/watcher.js';
import type { PipelineEvent } from '../events/schema.js';

const tmpDir = resolve(process.env.TMPDIR ?? '/tmp', `case-watch-test-${Date.now()}`);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeEvent(partial: Partial<PipelineEvent> & { event: string }): string {
  const base = {
    ts: new Date().toISOString(),
    sequence: 1,
    runId: 'run-1',
  };
  return JSON.stringify({ ...base, ...partial });
}

describe('watchEventLog', () => {
  test('replays existing events and stops on pipeline_end', async () => {
    const taskSlug = 'test-replay';
    const eventDir = resolve(tmpDir, '.case', taskSlug, 'events');
    await mkdir(eventDir, { recursive: true });

    const logPath = resolve(eventDir, 'run-test.jsonl');
    const events = [
      makeEvent({ event: 'pipeline_start', sequence: 1, taskId: 'task-1', profile: 'standard', plan: {} as any }),
      makeEvent({ event: 'phase_start', sequence: 2, phase: 'implement', agent: 'implementer' }),
      makeEvent({
        event: 'phase_end',
        sequence: 3,
        phase: 'implement',
        agent: 'implementer',
        outcome: 'completed',
        durationMs: 5000,
      }),
      makeEvent({ event: 'pipeline_end', sequence: 4, outcome: 'completed', durationMs: 10000 }),
    ];
    await writeFile(logPath, events.join('\n') + '\n');

    const collected: PipelineEvent[] = [];
    for await (const event of watchEventLog({
      taskSlug,
      caseRoot: tmpDir,
      runId: 'test',
      format: 'structured',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(4);
    expect(collected[0].event).toBe('pipeline_start');
    expect(collected[3].event).toBe('pipeline_end');
  });

  test('structured mode includes tool events (milestone set expanded)', async () => {
    const taskSlug = 'test-filter';
    const eventDir = resolve(tmpDir, '.case', taskSlug, 'events');
    await mkdir(eventDir, { recursive: true });

    const logPath = resolve(eventDir, 'run-filter.jsonl');
    const events = [
      makeEvent({ event: 'pipeline_start', sequence: 1, taskId: 'task-1', profile: 'standard', plan: {} as any }),
      makeEvent({
        event: 'tool_start',
        sequence: 2,
        phase: 'implement',
        agent: 'implementer',
        toolCallId: 't1',
        tool: 'Read',
        args: '{}',
      }),
      makeEvent({
        event: 'tool_end',
        sequence: 3,
        phase: 'implement',
        agent: 'implementer',
        toolCallId: 't1',
        tool: 'Read',
        durationMs: 50,
        isError: false,
        result: 'ok',
      }),
      makeEvent({ event: 'pipeline_end', sequence: 4, outcome: 'completed', durationMs: 10000 }),
    ];
    await writeFile(logPath, events.join('\n') + '\n');

    const collected: PipelineEvent[] = [];
    for await (const event of watchEventLog({
      taskSlug,
      caseRoot: tmpDir,
      runId: 'filter',
      format: 'structured',
    })) {
      collected.push(event);
    }

    // Tool events are now shown by default — pipeline_start + tool_start + tool_end + pipeline_end.
    expect(collected).toHaveLength(4);
    expect(collected.map((e) => e.event)).toEqual(['pipeline_start', 'tool_start', 'tool_end', 'pipeline_end']);
  });

  test('raw mode yields all events', async () => {
    const taskSlug = 'test-raw';
    const eventDir = resolve(tmpDir, '.case', taskSlug, 'events');
    await mkdir(eventDir, { recursive: true });

    const logPath = resolve(eventDir, 'run-raw.jsonl');
    const events = [
      makeEvent({ event: 'pipeline_start', sequence: 1, taskId: 'task-1', profile: 'standard', plan: {} as any }),
      makeEvent({
        event: 'tool_start',
        sequence: 2,
        phase: 'implement',
        agent: 'implementer',
        toolCallId: 't1',
        tool: 'Read',
        args: '{}',
      }),
      makeEvent({ event: 'pipeline_end', sequence: 3, outcome: 'completed', durationMs: 10000 }),
    ];
    await writeFile(logPath, events.join('\n') + '\n');

    const collected: PipelineEvent[] = [];
    for await (const event of watchEventLog({
      taskSlug,
      caseRoot: tmpDir,
      runId: 'raw',
      format: 'raw',
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(3);
  });

  test('skips partial trailing line (no final newline)', async () => {
    const taskSlug = 'test-partial';
    const eventDir = resolve(tmpDir, '.case', taskSlug, 'events');
    await mkdir(eventDir, { recursive: true });

    const logPath = resolve(eventDir, 'run-partial.jsonl');
    const complete = makeEvent({
      event: 'pipeline_start',
      sequence: 1,
      taskId: 'task-1',
      profile: 'standard',
      plan: {} as any,
    });
    const partial = '{"event":"pipeline_end","sequence":2'; // intentionally truncated
    await writeFile(logPath, complete + '\n' + partial);

    // Append the rest after a delay to simulate live writing
    setTimeout(async () => {
      const rest = `,"runId":"run-1","ts":"2026-01-01","outcome":"completed","durationMs":100}\n`;
      await appendFile(logPath, rest);
    }, 300);

    const collected: PipelineEvent[] = [];
    for await (const event of watchEventLog({
      taskSlug,
      caseRoot: tmpDir,
      runId: 'partial',
      format: 'raw',
      pollIntervalMs: 100,
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(2);
    expect(collected[1].event).toBe('pipeline_end');
  });

  test('incremental read yields new events as they are appended', async () => {
    const taskSlug = 'test-incremental';
    const eventDir = resolve(tmpDir, '.case', taskSlug, 'events');
    await mkdir(eventDir, { recursive: true });

    const logPath = resolve(eventDir, 'run-incr.jsonl');
    const initial = makeEvent({
      event: 'pipeline_start',
      sequence: 1,
      taskId: 'task-1',
      profile: 'standard',
      plan: {} as any,
    });
    await writeFile(logPath, initial + '\n');

    // Append more events after a delay
    setTimeout(async () => {
      await appendFile(
        logPath,
        makeEvent({ event: 'phase_start', sequence: 2, phase: 'implement', agent: 'implementer' }) + '\n',
      );
    }, 200);
    setTimeout(async () => {
      await appendFile(
        logPath,
        makeEvent({ event: 'pipeline_end', sequence: 3, outcome: 'completed', durationMs: 5000 }) + '\n',
      );
    }, 400);

    const collected: PipelineEvent[] = [];
    for await (const event of watchEventLog({
      taskSlug,
      caseRoot: tmpDir,
      runId: 'incr',
      format: 'structured',
      pollIntervalMs: 100,
    })) {
      collected.push(event);
    }

    expect(collected).toHaveLength(3);
    expect(collected[0].event).toBe('pipeline_start');
    expect(collected[1].event).toBe('phase_start');
    expect(collected[2].event).toBe('pipeline_end');
  });
});

// Renderer-specific tests live in `watch-renderer.spec.ts`.
