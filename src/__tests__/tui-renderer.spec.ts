import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTuiRenderer, type TuiSurface } from '../render/tui-renderer.js';

// Strip ANSI so assertions are stable regardless of color env.
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
  ticks: Array<() => void>;
  intervalsActive: number;
  clock: { value: number };
  surface: TuiSurface;
  recordedHeader: () => string;
  recordedFeed: () => string;
  started: () => boolean;
  stopped: () => boolean;
  stopCalls: () => number;
}

function makeHarness(): {
  harness: Harness;
  options: Parameters<typeof createTuiRenderer>[0];
} {
  const clock = { value: 0 };
  const ticks: Array<() => void> = [];
  const handles = new Map<number, () => void>();
  let nextHandle = 1;
  let intervalsActive = 0;

  let header = '';
  let feed = '';
  let started = false;
  let stopped = false;
  let stopCalls = 0;

  const surface: TuiSurface = {
    setHeader(text) {
      header = text;
    },
    setFeed(text) {
      feed = text;
    },
    start() {
      started = true;
    },
    stop() {
      stopped = true;
      stopCalls++;
    },
  };

  const options: Parameters<typeof createTuiRenderer>[0] = {
    mode: 'unattended',
    tui: surface,
    registerProcessHandlers: false,
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
    ticks,
    get intervalsActive() {
      return intervalsActive;
    },
    clock,
    surface,
    recordedHeader: () => header,
    recordedFeed: () => feed,
    started: () => started,
    stopped: () => stopped,
    stopCalls: () => stopCalls,
  } as Harness;

  return { harness, options };
}

describe('TuiRenderer', () => {
  test('start() is invoked on construction', () => {
    const { harness, options } = makeHarness();
    createTuiRenderer(options);
    expect(harness.started()).toBe(true);
  });

  test('phaseStart records active phase and appends to feed', () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    r.phaseStart('implement' as any, 'implementer');
    const state = r._state();
    expect(state.activePhase).toBe('implement');
    expect(state.feed.some((line) => line.includes('implement') && line.includes('implementer'))).toBe(true);
    expect(harness.recordedFeed().includes('implement')).toBe(true);
  });

  test('multiple phaseStart calls move previous active to completed', () => {
    const { options } = makeHarness();
    const r = createTuiRenderer(options);
    r.phaseStart('implement' as any, 'implementer');
    r.phaseStart('verify' as any, 'verifier');
    const state = r._state();
    expect(state.completedPhases).toEqual(['implement']);
    expect(state.activePhase).toBe('verify');
  });

  test('phaseEnd marks the phase completed and writes a closing line', () => {
    const { options } = makeHarness();
    const r = createTuiRenderer(options);
    r.phaseStart('implement' as any, 'implementer');
    r.phaseEnd('implement' as any, 'implementer', 5_000, 'completed');
    const state = r._state();
    expect(state.completedPhases).toContain('implement');
    expect(state.activePhase).toBeNull();
    expect(state.feed.some((line) => line.includes('completed'))).toBe(true);
  });

  test('toolStart appends a tool line to the feed', () => {
    const { options } = makeHarness();
    const r = createTuiRenderer(options);
    r.toolStart('Read', 'src/foo.ts');
    const state = r._state();
    expect(state.feed.some((line) => line.includes('Read') && line.includes('src/foo.ts'))).toBe(true);
  });

  test('toolEnd appends a duration line; errors include (error) marker', () => {
    const { options } = makeHarness();
    const r = createTuiRenderer(options);
    r.toolEnd('Bash', 1_000, true);
    const state = r._state();
    const last = state.feed[state.feed.length - 1]!;
    expect(last.includes('Bash')).toBe(true);
    expect(last.includes('(error)')).toBe(true);
  });

  test('feed buffer caps at maxFeedLines (oldest dropped)', () => {
    const { options } = makeHarness();
    const r = createTuiRenderer({ ...options, maxFeedLines: 5 });
    for (let i = 0; i < 12; i++) {
      r.send(`line-${i}`);
    }
    const state = r._state();
    expect(state.feed.length).toBe(5);
    // Oldest dropped: feed should start at the most recent five.
    expect(state.feed[0]).toBe('line-7');
    expect(state.feed[4]).toBe('line-11');
  });

  test('stepIndicator overrides header phase state', () => {
    const { options } = makeHarness();
    const r = createTuiRenderer(options);
    r.stepIndicator(['implement', 'verify'], 'review', ['close', 'retrospective']);
    const state = r._state();
    expect(state.completedPhases).toEqual(['implement', 'verify']);
    expect(state.activePhase).toBe('review');
    expect(state.pendingPhases).toEqual(['close', 'retrospective']);
  });

  test('startHeartbeat registers an interval, stopHeartbeat clears it', () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    expect(harness.intervalsActive).toBe(0);
    r.startHeartbeat();
    expect(harness.intervalsActive).toBe(1);
    expect(r._state().heartbeatActive).toBe(true);
    r.stopHeartbeat();
    expect(harness.intervalsActive).toBe(0);
    expect(r._state().heartbeatActive).toBe(false);
  });

  test('startHeartbeat is idempotent (replaces prior timer)', () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    r.startHeartbeat();
    r.startHeartbeat();
    expect(harness.intervalsActive).toBe(1);
    r.stopHeartbeat();
  });

  test('heartbeat tick appends a thinking line and rotates whimsy', () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    harness.clock.value = 1_000;
    r.startHeartbeat();
    harness.clock.value = 11_000;
    harness.ticks[0]!();
    harness.ticks[0]!();
    const feed = r._state().feed;
    const last = feed[feed.length - 1]!;
    const prev = feed[feed.length - 2]!;
    expect(prev.includes('thinking...')).toBe(true);
    expect(last.includes('pondering...')).toBe(true);
  });

  test('toolStart resets the heartbeat elapsed/whimsy counters', () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    harness.clock.value = 0;
    r.startHeartbeat();
    harness.ticks[0]!(); // tick 0 → "thinking..."
    harness.clock.value = 5_000;
    r.toolStart('Read', 'foo.ts'); // resets
    harness.clock.value = 8_000;
    harness.ticks[0]!(); // tick 0 again → "thinking..." with 3s elapsed
    const feed = r._state().feed;
    const last = feed[feed.length - 1]!;
    expect(last.includes('thinking...')).toBe(true);
    expect(last.includes('3s')).toBe(true);
  });

  test('destroy() stops the surface and clears the heartbeat timer', () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    r.startHeartbeat();
    expect(harness.intervalsActive).toBe(1);
    r.destroy();
    expect(harness.stopped()).toBe(true);
    expect(harness.intervalsActive).toBe(0);
  });

  test('destroy() is idempotent', () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    r.destroy();
    r.destroy();
    expect(harness.stopCalls()).toBe(1);
  });

  test('destroy() is called when pipeline fails (simulated try/finally)', () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    try {
      r.phaseStart('implement' as any, 'implementer');
      throw new Error('boom');
    } catch {
      // swallow
    } finally {
      r.destroy();
    }
    expect(harness.stopped()).toBe(true);
  });

  test('header text reflects the most recent phase state', () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    r.stepIndicator(['implement'], 'verify', ['review', 'close']);
    const header = harness.recordedHeader();
    expect(header.includes('Case Pipeline')).toBe(true);
    expect(header.includes('implement')).toBe(true);
    expect(header.includes('verify')).toBe(true);
    expect(header.includes('review')).toBe(true);
    expect(header.includes('1/4')).toBe(true);
  });

  test('send() routes message into the feed', () => {
    const { options } = makeHarness();
    const r = createTuiRenderer(options);
    r.send('hello world');
    const state = r._state();
    expect(state.feed).toContain('hello world');
  });

  test('askUser in unattended mode tears down TUI and auto-selects last option', async () => {
    const { harness, options } = makeHarness();
    const r = createTuiRenderer(options);
    const choice = await r.askUser('pick one', ['A', 'B', 'C']);
    expect(choice).toBe('C');
    expect(harness.stopped()).toBe(true);
  });
});
