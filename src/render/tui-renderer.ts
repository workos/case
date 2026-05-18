/**
 * TUI renderer — implements the Notifier interface using @mariozechner/pi-tui.
 *
 * Reuses the structured-log's text formatters (format.ts) and ANSI helpers
 * (color.ts) so visual style matches the line-based renderer. The only thing
 * that changes is the rendering target: lines are routed into pi-tui Text
 * components (header + scrolling feed) instead of stdout.
 *
 * Pi-tui's actual API differs from the spec's aspirational sketch:
 *   - It exposes `TUI` (a `Container`), `Box`, `Text`, and `Loader` components
 *     that render to `string[]` for a given viewport width. There is no
 *     "PipelineHeader" or "ActivityFeed" base class to extend.
 *   - Components are updated by calling `setText()` (or rebuilding child
 *     lists) and then asking the TUI for a redraw.
 *
 * To match the spec's intent without fighting the library, we keep two `Text`
 * components — one for the header (title + step indicator + progress bar) and
 * one for the activity feed (a buffered list of recent lines, capped at 100).
 * Header state lives on the renderer; the components only render strings.
 *
 * `destroy()` tears down the pi-tui terminal and releases SIGINT/exit
 * handlers, restoring the terminal even on crash.
 */

import { Box, ProcessTerminal, Text, TUI } from '@mariozechner/pi-tui';
import type { Notifier } from '../notify.js';
import { defaultAskUser } from '../notify.js';
import type { PipelineMode } from '../types.js';
import { bold, cyan, dim, green, red, yellow } from './color.js';
import {
  formatDuration,
  formatHeartbeatWhimsy,
  formatPhaseEnd,
  formatPhaseHeader,
  formatToolLine,
} from './format.js';

/** Duration thresholds for color escalation (ms). Mirrors structured-log.ts. */
const DURATION_YELLOW_MS = 30_000;
const DURATION_RED_MS = 120_000;

/** Activity feed buffer cap. */
const MAX_FEED_LINES = 100;

/** Progress bar width (characters between brackets). */
const PROGRESS_BAR_WIDTH = 40;

export interface TuiRendererOptions {
  mode: PipelineMode;
  /** Heartbeat tick interval (ms). Default 10_000. */
  heartbeatIntervalMs?: number;
  /** Override wall clock (testing). Default Date.now. */
  now?: () => number;
  /** Override interval scheduler (testing). */
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /**
   * Optional renderer factory override (testing). When set, `createTuiRenderer`
   * uses this surface instead of constructing a real pi-tui `TUI`. Tests pass
   * a recording stub so they can assert on state without spawning a real
   * terminal. Production code never sets this.
   */
  tui?: TuiSurface;
  /** Register process.on('exit'/'SIGINT') handlers (default true). */
  registerProcessHandlers?: boolean;
  /** Custom max feed lines (testing only — production uses MAX_FEED_LINES). */
  maxFeedLines?: number;
}

/**
 * Minimal surface the renderer needs from pi-tui. Production wires this to a
 * real `TUI` instance; tests substitute a recording stub.
 */
export interface TuiSurface {
  setHeader(text: string): void;
  setFeed(text: string): void;
  start(): void;
  stop(): void;
}

export interface TuiRendererState {
  completedPhases: string[];
  activePhase: string | null;
  pendingPhases: string[];
  feed: string[];
  heartbeatActive: boolean;
}

export interface TuiRenderer extends Notifier {
  destroy(): void;
  /** Read-only snapshot of internal state for testing. */
  _state(): TuiRendererState;
}

/**
 * Color a duration string by magnitude.
 *   < 30s  → default; < 2min → yellow; ≥ 2min → red.
 */
function colorDuration(durationMs: number): string {
  const text = formatDuration(durationMs);
  if (durationMs >= DURATION_RED_MS) return red(text);
  if (durationMs >= DURATION_YELLOW_MS) return yellow(text);
  return text;
}

/** Color a tool activity line: dim body, threshold-colored duration. */
function colorToolLine(tool: string, args: string, durationMs?: number): string {
  if (durationMs === undefined) return dim(formatToolLine(tool, args));
  const raw = formatToolLine(tool, args, durationMs);
  const durText = formatDuration(durationMs);
  const left = raw.endsWith(durText) ? raw.slice(0, raw.length - durText.length) : raw;
  return `${dim(left)}${colorDuration(durationMs)}`;
}

/** Re-color a formatted phase-end line. */
function colorPhaseEndLine(
  phase: string,
  agent: string,
  durationMs: number,
  status: 'completed' | 'failed',
): string {
  const raw = formatPhaseEnd(phase, agent, durationMs, status);
  const durText = formatDuration(durationMs);
  const body = raw.endsWith(durText) ? raw.slice(0, raw.length - durText.length) : raw;
  const icon = status === 'completed' ? green(body[0]!) : red(body[0]!);
  return `${icon}${body.slice(1)}${colorDuration(durationMs)}`;
}

/** Color a phase header line (bold prefix, dim trailing separator). */
function colorPhaseHeader(phase: string, agent: string): string {
  const raw = formatPhaseHeader(phase, agent);
  const sepMatch = raw.match(/─+$/);
  if (!sepMatch) return bold(raw);
  const sepStart = raw.length - sepMatch[0].length;
  return `${bold(raw.slice(0, sepStart))}${dim(raw.slice(sepStart))}`;
}

/** Build a Unicode progress bar like `[████████▒▒▒▒▒▒▒▒                ] 2/5`. */
function renderProgressBar(completed: number, total: number): string {
  if (total <= 0) return `[${' '.repeat(PROGRESS_BAR_WIDTH)}] 0/0`;
  const filled = Math.min(PROGRESS_BAR_WIDTH, Math.floor((completed / total) * PROGRESS_BAR_WIDTH));
  const empty = Math.max(0, PROGRESS_BAR_WIDTH - filled);
  const bar = `${green('█'.repeat(filled))}${dim('▒'.repeat(empty))}`;
  return `[${bar}] ${completed}/${total}`;
}

/** Build the step-indicator row with colored markers. */
function renderStepIndicator(completed: string[], active: string | null, pending: string[]): string {
  const parts: string[] = [];
  for (const phase of completed) parts.push(`${green('✓')} ${phase}`);
  if (active) parts.push(`${cyan('●')} ${active}`);
  for (const phase of pending) parts.push(`${dim('○')} ${dim(phase)}`);
  return parts.join('  ');
}

/** Build the full header text (title + indicator + progress bar). */
function renderHeader(state: TuiRendererState): string {
  const total = state.completedPhases.length + (state.activePhase ? 1 : 0) + state.pendingPhases.length;
  const done = state.completedPhases.length;
  const title = bold('Case Pipeline');
  const indicator = renderStepIndicator(state.completedPhases, state.activePhase, state.pendingPhases);
  const progress = renderProgressBar(done, total);
  return `${title}\n${indicator}\n${progress}`;
}

/**
 * Build a real pi-tui surface backed by `ProcessTerminal`. Composed of:
 *   - a header `Box` containing a `Text` for title/indicator/bar
 *   - a feed `Box` containing a `Text` for the scrolling activity lines
 */
function createProcessTuiSurface(): TuiSurface {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal, false);

  const headerText = new Text('', 1, 0);
  const headerBox = new Box(1, 0);
  headerBox.addChild(headerText);

  const feedText = new Text('', 1, 0);
  const feedBox = new Box(1, 1);
  feedBox.addChild(feedText);

  tui.addChild(headerBox);
  tui.addChild(feedBox);

  return {
    setHeader(text) {
      headerText.setText(text);
      tui.requestRender();
    },
    setFeed(text) {
      feedText.setText(text);
      tui.requestRender();
    },
    start() {
      tui.start();
    },
    stop() {
      try {
        tui.stop();
      } finally {
        terminal.stop();
      }
    },
  };
}

/**
 * TUI renderer factory. Returns a Notifier with a `destroy()` cleanup hook.
 *
 * The renderer keeps its own state (completed/active/pending phases, feed
 * buffer, heartbeat tick state) and re-renders header/feed text on each
 * event. pi-tui handles the actual terminal diffing and redraw.
 */
export function createTuiRenderer(options: TuiRendererOptions): TuiRenderer {
  const mode = options.mode;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
  const now = options.now ?? (() => Date.now());
  const setIntervalFn = options.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const maxFeedLines = options.maxFeedLines ?? MAX_FEED_LINES;
  const registerProcessHandlers = options.registerProcessHandlers ?? true;

  const surface = options.tui ?? createProcessTuiSurface();

  const state: TuiRendererState = {
    completedPhases: [],
    activePhase: null,
    pendingPhases: [],
    feed: [],
    heartbeatActive: false,
  };

  let heartbeatTimer: unknown = null;
  let lastActivityAt = 0;
  let tickCount = 0;
  let destroyed = false;

  function pushFeed(line: string): void {
    state.feed.push(line);
    if (state.feed.length > maxFeedLines) {
      state.feed.splice(0, state.feed.length - maxFeedLines);
    }
    surface.setFeed(state.feed.join('\n'));
  }

  function refreshHeader(): void {
    surface.setHeader(renderHeader(state));
  }

  function transitionToPhase(phase: string): void {
    // If there's an active phase, move it to completed before activating the new one.
    if (state.activePhase && state.activePhase !== phase) {
      state.completedPhases.push(state.activePhase);
    }
    // Drop the new phase from pending (if present).
    state.pendingPhases = state.pendingPhases.filter((p) => p !== phase);
    state.activePhase = phase;
    refreshHeader();
  }

  // Start the TUI surface immediately so the empty header/feed are visible.
  surface.start();
  refreshHeader();

  // Terminal safety: always restore on exit, SIGINT, uncaughtException.
  const exitHandler = () => destroy();
  const sigintHandler = () => {
    destroy();
    process.exit(130);
  };
  if (registerProcessHandlers) {
    process.on('exit', exitHandler);
    process.on('SIGINT', sigintHandler);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    try {
      if (heartbeatTimer !== null) {
        clearIntervalFn(heartbeatTimer);
        heartbeatTimer = null;
        state.heartbeatActive = false;
      }
      surface.stop();
    } catch {
      // best-effort cleanup
    }
    if (registerProcessHandlers) {
      process.off('exit', exitHandler);
      process.off('SIGINT', sigintHandler);
    }
  }

  const notifier: Notifier = {
    send(message) {
      pushFeed(message);
    },

    phaseStart(phase, agent) {
      lastActivityAt = now();
      tickCount = 0;
      transitionToPhase(phase);
      // Visual separation between phases.
      if (state.feed.length > 0) pushFeed('');
      pushFeed(colorPhaseHeader(phase, agent));
    },

    phaseEnd(phase, agent, durationMs, status) {
      // Mark the phase as completed in the header, clear active.
      if (state.activePhase === phase) {
        state.completedPhases.push(phase);
        state.activePhase = null;
      }
      refreshHeader();
      pushFeed(colorPhaseEndLine(phase, agent, durationMs, status));
    },

    toolStart(tool, args) {
      lastActivityAt = now();
      tickCount = 0;
      pushFeed(colorToolLine(tool, args));
    },

    toolEnd(tool, durationMs, isError) {
      lastActivityAt = now();
      tickCount = 0;
      const suffix = isError ? red(' (error)') : '';
      pushFeed(`${colorToolLine(tool, '', durationMs)}${suffix}`);
    },

    stepIndicator(completed, active, pending) {
      state.completedPhases = [...completed];
      state.activePhase = active || null;
      state.pendingPhases = [...pending];
      refreshHeader();
    },

    startHeartbeat() {
      if (heartbeatTimer !== null) {
        clearIntervalFn(heartbeatTimer);
        heartbeatTimer = null;
      }
      lastActivityAt = now();
      tickCount = 0;
      state.heartbeatActive = true;
      heartbeatTimer = setIntervalFn(() => {
        const elapsed = now() - lastActivityAt;
        pushFeed(dim(formatHeartbeatWhimsy(elapsed, tickCount)));
        tickCount++;
      }, heartbeatIntervalMs);
    },

    stopHeartbeat() {
      if (heartbeatTimer !== null) {
        clearIntervalFn(heartbeatTimer);
        heartbeatTimer = null;
      }
      state.heartbeatActive = false;
    },

    async askUser(userPrompt, choices) {
      // Tear down the TUI so the prompt can use plain stdin/stdout. The
      // pipeline doesn't restart it after — askUser is only reached at
      // failure-recovery handoffs where the structured experience would
      // already be paused.
      destroy();
      return defaultAskUser(mode, userPrompt, choices);
    },
  };

  return {
    ...notifier,
    destroy,
    _state(): TuiRendererState {
      return {
        completedPhases: [...state.completedPhases],
        activePhase: state.activePhase,
        pendingPhases: [...state.pendingPhases],
        feed: [...state.feed],
        heartbeatActive: state.heartbeatActive,
      };
    },
  };
}
