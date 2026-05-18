import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createStructuredLogRenderer } from '../render/structured-log.js';

// Lock color OFF for all structured-log tests so assertions that compare exact
// strings (no ANSI escapes) are stable regardless of the host environment.
let savedNoColor: string | undefined;
let savedForceColor: string | undefined;

beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  savedForceColor = process.env.FORCE_COLOR;
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
});

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  if (savedForceColor === undefined) delete process.env.FORCE_COLOR;
  else process.env.FORCE_COLOR = savedForceColor;
});

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

  test('heartbeat rotates whimsy messages across ticks', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.startHeartbeat();
    harness.ticks[0]!(); // tick 0 → "thinking..."
    harness.ticks[0]!(); // tick 1 → "pondering..."
    expect(harness.lines[harness.lines.length - 2]!.includes('thinking...')).toBe(true);
    expect(harness.lines[harness.lines.length - 1]!.includes('pondering...')).toBe(true);
  });

  test('toolStart resets the whimsy tick counter', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.startHeartbeat();
    harness.ticks[0]!(); // tick 0 → "thinking..."
    harness.ticks[0]!(); // tick 1 → "pondering..."
    n.toolStart('Read', 'x.ts'); // resets tick to 0
    harness.ticks[0]!(); // tick 0 → "thinking..." again
    const last = harness.lines[harness.lines.length - 1]!;
    expect(last.includes('thinking...')).toBe(true);
    expect(last.includes('pondering...')).toBe(false);
  });
});

describe('StructuredLogRenderer color thresholds (FORCE_COLOR)', () => {
  // These tests opt back into color to verify boundary thresholds.
  beforeEach(() => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
  });

  function lastLine(harness: Harness): string {
    return harness.lines[harness.lines.length - 1]!;
  }

  test('duration 29s is default (no yellow/red ANSI code)', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.toolEnd('Read', 29_000, false);
    const out = lastLine(harness);
    expect(out.includes('\x1b[33m')).toBe(false); // no yellow
    expect(out.includes('\x1b[31m29s')).toBe(false); // 29s not red
  });

  test('duration 30s is yellow', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.toolEnd('Read', 30_000, false);
    expect(lastLine(harness).includes('\x1b[33m30s\x1b[0m')).toBe(true);
  });

  test('duration 119s is yellow (just under 2min)', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.toolEnd('Read', 119_000, false);
    expect(lastLine(harness).includes('\x1b[33m')).toBe(true);
    expect(lastLine(harness).includes('\x1b[31m1m')).toBe(false);
  });

  test('duration 120s is red', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.toolEnd('Read', 120_000, false);
    expect(lastLine(harness).includes('\x1b[31m2m 0s\x1b[0m')).toBe(true);
  });

  test('phaseEnd completed uses green icon', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.phaseEnd('implement' as any, 'implementer', 5_000, 'completed');
    expect(lastLine(harness).startsWith('\x1b[32m✓\x1b[0m')).toBe(true);
  });

  test('phaseEnd failed uses red icon', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.phaseEnd('implement' as any, 'implementer', 5_000, 'failed');
    expect(lastLine(harness).startsWith('\x1b[31m✗\x1b[0m')).toBe(true);
  });

  test('stepIndicator uses green ✓, cyan ○, dim ·', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.stepIndicator(['implement'], 'verify', ['review']);
    const out = lastLine(harness);
    expect(out.includes('\x1b[32m✓\x1b[0m')).toBe(true);
    expect(out.includes('\x1b[36m○\x1b[0m')).toBe(true);
    expect(out.includes('\x1b[2m·\x1b[0m')).toBe(true);
  });

  test('phaseStart wraps prefix in bold and separator in dim', () => {
    const { harness, options } = makeHarness();
    const n = createStructuredLogRenderer(options);
    n.phaseStart('implement' as any, 'implementer');
    const out = lastLine(harness);
    expect(out.startsWith('\x1b[1m')).toBe(true); // bold prefix
    expect(out.includes('\x1b[2m─')).toBe(true); // dim separator
  });
});
