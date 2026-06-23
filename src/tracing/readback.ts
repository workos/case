/**
 * Langfuse read-back client + helpers.
 *
 * The control path never reads Langfuse (RFC §1, §7) — but **human tools** may.
 * Two consumers share this module:
 *   - the e2e tier (Phase 2.1), which reads a trace back to prove the dispatch wire;
 *   - `ca watch` (Phase 2.2), which loads a run's observations then polls for new
 *     ones to drive a live terminal tail (Langfuse has no push API, so "subscribe"
 *     is poll-with-cursor — exactly what the dashboard does).
 *
 * Always a **separate read-only client** from the tracer's write client, keeping the
 * §7 control-path/observability separation intact. Ingestion is async + batched
 * (SDK flush → ClickHouse write interval), so a trace/observation is not queryable
 * the instant it is dispatched — callers poll with a deadline.
 */
import { Langfuse } from 'langfuse';

export interface ReadConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

/** Read the project keys + host the same way the tracer does. Null when keys absent. */
export function readConfig(): ReadConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;
  const baseUrl = process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3000';
  return { publicKey, secretKey, baseUrl };
}

/** Tier 1 e2e gate: opt-in flag + a reachable, keyed Langfuse. */
export function e2eEnabled(): boolean {
  return process.env.LANGFUSE_E2E === '1' && readConfig() !== null;
}

/** Tier 2 e2e gate: the heavier real-LLM smoke, behind its own flag. */
export function llmE2eEnabled(): boolean {
  return process.env.LANGFUSE_E2E_LLM === '1' && readConfig() !== null;
}

/** A read-only client, independent of any write client (honors §7 separation). */
export function makeReadClient(): Langfuse {
  const cfg = readConfig();
  if (!cfg) throw new Error('Langfuse keys absent — guard with readConfig()/e2eEnabled() before calling.');
  return new Langfuse({ publicKey: cfg.publicKey, secretKey: cfg.secretKey, baseUrl: cfg.baseUrl });
}

/** A single observation as returned by the public trace-details API (loosely typed). */
export interface Observation {
  id: string;
  type: 'SPAN' | 'GENERATION' | 'EVENT' | string;
  name?: string | null;
  model?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  level?: string | null;
  parentObservationId?: string | null;
  usageDetails?: Record<string, number> | null;
  costDetails?: Record<string, number> | null;
  input?: unknown;
  output?: unknown;
}

export interface TraceScore {
  name?: string | null;
  value?: number | null;
  comment?: string | null;
}

export interface TraceDetails {
  id: string;
  observations: Observation[];
  scores: TraceScore[];
}

/**
 * Resolve the most recent trace id for a trace name (e.g. `case-run:<taskId>`).
 * Returns null when no trace exists yet (run hasn't dispatched, or keys-absent run
 * produced no trace). `ca watch` polls this until a trace appears.
 */
export async function listLatestTraceIdByName(client: Langfuse, name: string): Promise<string | null> {
  try {
    const res = (await client.api.traceList({ name, orderBy: 'timestamp.desc', limit: 1 })) as unknown as {
      data?: Array<{ id: string }>;
    };
    return res.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Fetch a trace's full observation + score set. Throws on transport error (caller decides retry). */
export async function getTraceDetails(client: Langfuse, traceId: string): Promise<TraceDetails> {
  return (await client.api.traceGet(traceId)) as unknown as TraceDetails;
}

/**
 * Poll the public trace API until at least `minObservations` are present.
 * Throws on timeout so the assertion failure points at "ingest never landed".
 */
export async function pollTrace(
  client: Langfuse,
  traceId: string,
  opts: { minObservations?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<TraceDetails> {
  const minObservations = opts.minObservations ?? 1;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_500;

  const deadline = Date.now() + timeoutMs;
  let last: TraceDetails | null = null;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    try {
      const trace = await getTraceDetails(client, traceId);
      last = trace;
      if ((trace.observations?.length ?? 0) >= minObservations) return trace;
    } catch (e) {
      // 404 until the trace is first ingested — expected; keep polling.
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  const got = last?.observations?.length ?? 0;
  throw new Error(
    `pollTrace timed out after ${timeoutMs}ms for trace ${traceId}: ` +
      `got ${got}/${minObservations} observations` +
      (lastErr ? ` (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : ''),
  );
}

export const byName = (obs: Observation[], name: string): Observation | undefined => obs.find((o) => o.name === name);

export const ofType = (obs: Observation[], type: string): Observation[] => obs.filter((o) => o.type === type);
