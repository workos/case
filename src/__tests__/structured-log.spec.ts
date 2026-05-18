import { describe, test, expect } from 'bun:test';
import { createStructuredLogRenderer } from '../render/structured-log.js';

interface Harness {
  lines: string[];
  ticks: Array<() => void>;
  intervalsActive: number;
  clock: { value: number };
}

function makeHarness(): {
  harness: Harness;
  options: Parameters<typeof createStructuredLogRenderer>[0];
} {
  const lines: string[] = [];
  const ticks: Array<() => void> = [];
  const clock = { value: 0 };
  let intervalsActive = 0;
  const handles = new Map<number, () => void>();
  let nextHandle = 1;

  const options: Parameters<typeof createStructuredLogRenderer>[0] = {
    mode: 'unattended',
    write: (text) => {
      // Strip trailing newline so tests can compare clean lines.
      for (const part of text.split('\n')) {
        if (part.length > 0) lines.push(part);
      }
    },
    now: () => clock.value,
    setInterval: (cb) => {
      const id = nextHandle++;
      handles.set(id, cb);
      ticks.push(cb);
      intervalsActive++;
      return id;
    },
    clearInterval: (handle) => {
      if (typeof handle === 'number' && handles.delete(handle)) {
        intervalsActive--;
      }
    },
    heartbeatIntervalMs: 10_000,
  };

  const harness: Harness = {
    lines,
    ticks,
    get intervalsActive() {
      return intervalsActive;
    },
    clock,
  } as Harness;

  return { harness, options };
}

describe('StructuredLogRenderer', () => {
  test('phaseStart prints header line', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.phaseStart('implement' as any, 'implementer');
    expect(harness.lines.length).toBe(1);
    expect(harness.lines[0].startsWith('▶ implement (implementer)')).toBe(true);
  });

  test('phaseEnd prints completion line with ✓', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.phaseEnd('implement' as any, 'implementer', 5_000, 'completed');
    expect(harness.lines[0].startsWith('✓ implement completed')).toBe(true);
    expect(harness.lines[0].endsWith('5s')).toBe(true);
  });

  test('phaseEnd prints failure line with ✗', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.phaseEnd('implement' as any, 'implementer', 5_000, 'failed');
    expect(harness.lines[0].startsWith('✗ implement failed')).toBe(true);
  });

  test('toolStart prints indented tool line', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.toolStart('Read', 'src/foo.ts');
    expect(harness.lines[0]).toBe('    ↳ Read src/foo.ts');
  });

  test('toolEnd prints duration', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.toolEnd('Read', 2_000, false);
    expect(harness.lines[0].endsWith('2s')).toBe(true);
  });

  test('toolEnd marks errors', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.toolEnd('Bash', 1_000, true);
    expect(harness.lines[0].includes('(error)')).toBe(true);
  });

  test('stepIndicator prints position', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.stepIndicator(['implement'], 'verify', ['review']);
    expect(harness.lines[0]).toBe('[2/3] ✓ implement → ○ verify → · review');
  });

  test('startHeartbeat registers an interval; stopHeartbeat clears it', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    expect(harness.intervalsActive).toBe(0);
    n.startHeartbeat();
    expect(harness.intervalsActive).toBe(1);
    n.stopHeartbeat();
    expect(harness.intervalsActive).toBe(0);
  });

  test('heartbeat tick prints thinking line with elapsed since last activity', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    harness.clock.value = 1_000;
    n.startHeartbeat();
    // Simulate 10s of silence
    harness.clock.value = 11_000;
    harness.ticks[0]!();
    const last = harness.lines[harness.lines.length - 1];
    expect(last.includes('thinking')).toBe(true);
    expect(last.endsWith('10s)')).toBe(true);
  });

  test('toolStart resets the heartbeat elapsed counter', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    harness.clock.value = 0;
    n.startHeartbeat();
    harness.clock.value = 5_000;
    n.toolStart('Read', 'foo.ts'); // resets last-activity to 5_000
    harness.clock.value = 8_000;
    harness.ticks[0]!(); // 8000 - 5000 = 3000ms elapsed
    const last = harness.lines[harness.lines.length - 1];
    expect(last.includes('thinking')).toBe(true);
    expect(last.endsWith('3s)')).toBe(true);
  });

  test('startHeartbeat is idempotent (clears prior timer)', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.startHeartbeat();
    n.startHeartbeat();
    expect(harness.intervalsActive).toBe(1);
    n.stopHeartbeat();
    expect(harness.intervalsActive).toBe(0);
  });

  test('send prints message verbatim', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.send('hello');
    expect(harness.lines[0]).toBe('hello');
  });

  test('askUser in unattended mode auto-selects last option', async () => {
    const { options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    const choice = await n.askUser('pick one', ['A', 'B', 'C']);
    expect(choice).toBe('C');
  });
});
