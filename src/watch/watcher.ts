import type { Langfuse } from 'langfuse';
import {
  getTraceDetails,
  listLatestTraceIdByName,
  makeReadClient,
  readConfig,
  type Observation,
} from '../tracing/readback.js';

/**
 * `ca watch` data source (Phase 2.2).
 *
 * The granular JSONL event log was deleted, so the live tail now reads the run's
 * Langfuse trace: load the observations that already landed, then poll-with-cursor
 * for new ones (Langfuse has no push API — this is what the dashboard does). A
 * human tool reading Langfuse does **not** violate §7 (that bars the *control
 * path*). Requires Langfuse keys + reachability; ingest is async so events surface
 * seconds after they happen.
 */

export interface WatchOptions {
  /** Task id; the trace is named `case-run:<taskSlug>`. */
  taskSlug: string;
  /** Pin a specific run (trace id === runId). Default: latest trace for the task. */
  runId?: string;
  format?: 'structured' | 'raw';
  pollIntervalMs?: number;
  /** Give up if no new observation arrives for this long (run likely crashed without a retrospective). */
  maxIdleMs?: number;
  /** Overall ceiling before the tail returns regardless. */
  timeoutMs?: number;
  /** Injected read client (tests). Defaults to a real read-only client. */
  client?: Langfuse;
}

export type WatchRecord =
  | { kind: 'trace_start'; traceId: string; traceName: string }
  | { kind: 'span_start'; span: 'phase' | 'tool' | 'other'; name: string }
  | { kind: 'span_end'; span: 'phase' | 'tool' | 'other'; name: string; durationMs: number; isError: boolean }
  | { kind: 'generation'; model?: string; tokens?: number; cost?: number }
  | { kind: 'event'; name: string; data?: unknown }
  | { kind: 'score'; name: string; value: number; comment?: string }
  | { kind: 'run_complete' };

export class WatchKeysMissingError extends Error {
  override readonly name = 'WatchKeysMissingError';
  constructor() {
    super(
      'ca watch requires Langfuse — set LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY ' +
        '(the granular JSONL event log was removed in the LangGraph + Langfuse migration).',
    );
  }
}

function spanKind(name: string | null | undefined): { span: 'phase' | 'tool' | 'other'; label: string } {
  if (name?.startsWith('phase:')) return { span: 'phase', label: name.slice('phase:'.length) };
  if (name?.startsWith('tool:')) return { span: 'tool', label: name.slice('tool:'.length) };
  return { span: 'other', label: name ?? 'span' };
}

function durationMs(o: Observation): number {
  if (!o.startTime || !o.endTime) return 0;
  return Math.max(0, Date.parse(o.endTime) - Date.parse(o.startTime));
}

function generationTokens(o: Observation): number | undefined {
  const u = o.usageDetails;
  if (!u) return undefined;
  if (typeof u.total === 'number') return u.total;
  const sum = (u.input ?? 0) + (u.output ?? 0);
  return sum > 0 ? sum : undefined;
}

/** Translate an observation into watch records (start now; end emitted later when it gains an endTime). */
function startRecord(o: Observation, format: 'structured' | 'raw'): WatchRecord | null {
  switch (o.type) {
    case 'SPAN': {
      const { span, label } = spanKind(o.name);
      return { kind: 'span_start', span, name: label };
    }
    case 'GENERATION':
      // turn-level generations are noisy; structured tail hides them, raw shows them.
      if (format !== 'raw') return null;
      return {
        kind: 'generation',
        model: o.model ?? undefined,
        tokens: generationTokens(o),
        cost: o.costDetails?.total,
      };
    case 'EVENT':
      return { kind: 'event', name: o.name ?? 'event', data: o.input };
    default:
      return null;
  }
}

/**
 * Tail a run's Langfuse trace. Yields records as observations land, ending when the
 * retrospective phase span closes (the last phase) or on idle/overall timeout.
 */
export async function* watchTrace(options: WatchOptions): AsyncGenerator<WatchRecord> {
  const format = options.format ?? 'structured';
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxIdleMs = options.maxIdleMs ?? 60_000;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;

  if (!options.client && readConfig() === null) throw new WatchKeysMissingError();
  const client = options.client ?? makeReadClient();

  const traceName = `case-run:${options.taskSlug}`;

  // Resolve the trace id (pinned run, or the latest trace for the task). Poll until
  // it appears — the run may not have dispatched its first observation yet.
  let traceId = options.runId ?? null;
  const appearDeadline = Date.now() + Math.min(timeoutMs, 30_000);
  while (!traceId && Date.now() < appearDeadline) {
    traceId = await listLatestTraceIdByName(client, traceName);
    if (!traceId) await sleep(pollIntervalMs);
  }
  if (!traceId) return; // nothing to watch
  yield { kind: 'trace_start', traceId, traceName };

  const seen = new Set<string>();
  const ended = new Set<string>();
  const seenScores = new Set<string>();
  const overallDeadline = Date.now() + timeoutMs;
  let lastActivity = Date.now();

  while (Date.now() < overallDeadline) {
    let observations: Observation[] = [];
    let scores: { name?: string | null; value?: number | null; comment?: string | null }[] = [];
    try {
      const trace = await getTraceDetails(client, traceId);
      observations = trace.observations ?? [];
      scores = trace.scores ?? [];
    } catch {
      // Transient read error — keep polling.
      await sleep(pollIntervalMs);
      continue;
    }

    let activity = false;

    // New observations, in start order.
    const fresh = observations
      .filter((o) => !seen.has(o.id))
      .sort((a, b) => Date.parse(a.startTime ?? '') - Date.parse(b.startTime ?? ''));
    for (const o of fresh) {
      seen.add(o.id);
      const rec = startRecord(o, format);
      if (rec) {
        yield rec;
        activity = true;
      }
    }

    // Spans that have since closed → emit completion (and detect run end).
    let retrospectiveEnded = false;
    for (const o of observations) {
      if (o.type !== 'SPAN' || !o.endTime || ended.has(o.id)) continue;
      ended.add(o.id);
      const { span, label } = spanKind(o.name);
      yield { kind: 'span_end', span, name: label, durationMs: durationMs(o), isError: o.level === 'ERROR' };
      activity = true;
      if (span === 'phase' && label === 'retrospective') retrospectiveEnded = true;
    }

    // New scores (verifier/reviewer rubric categories).
    for (const s of scores) {
      const key = `${s.name}=${s.value}`;
      if (seenScores.has(key)) continue;
      seenScores.add(key);
      yield { kind: 'score', name: s.name ?? 'score', value: s.value ?? 0, comment: s.comment ?? undefined };
      activity = true;
    }

    if (retrospectiveEnded) {
      yield { kind: 'run_complete' };
      return;
    }

    if (activity) lastActivity = Date.now();
    else if (Date.now() - lastActivity > maxIdleMs) return; // run went quiet (likely crashed without retrospective)

    await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
