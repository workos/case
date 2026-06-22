/**
 * Shared E2E read-back helpers (Phase 2.1).
 *
 * The control path never reads Langfuse (RFC §7) — but a *test* may, and that
 * read-back is the only way to prove the dispatch wire actually lands: auth,
 * baseUrl, the ingest schema, the usage/cost mapping, and scores, all verified
 * against a real server.
 *
 * Ingestion is async + batched (SDK flush → ClickHouse write interval), so a
 * trace is not queryable the instant we dispatch — {@link pollTrace} retries
 * until the observations show up or a deadline passes.
 */
import { Langfuse } from 'langfuse';

export interface E2EConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

/** Read the project keys + host the same way the tracer does. */
function readConfig(): E2EConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;
  const baseUrl =
    process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3000';
  return { publicKey, secretKey, baseUrl };
}

/** Tier 1 gate: opt-in flag + a reachable, keyed Langfuse. */
export function e2eEnabled(): boolean {
  return process.env.LANGFUSE_E2E === '1' && readConfig() !== null;
}

/** Tier 2 gate: the heavier real-LLM smoke, behind its own flag. */
export function llmE2eEnabled(): boolean {
  return process.env.LANGFUSE_E2E_LLM === '1' && readConfig() !== null;
}

/** A read-only client, independent of the tracer's write client (honors §7 separation). */
export function makeReadClient(): Langfuse {
  const cfg = readConfig();
  if (!cfg) throw new Error('Langfuse E2E keys absent — guard with e2eEnabled() before calling.');
  return new Langfuse({ publicKey: cfg.publicKey, secretKey: cfg.secretKey, baseUrl: cfg.baseUrl });
}

/** A single observation as returned by the public trace-details API (loosely typed). */
export interface Observation {
  type: 'SPAN' | 'GENERATION' | 'EVENT' | string;
  name?: string | null;
  model?: string | null;
  usageDetails?: Record<string, number> | null;
  costDetails?: Record<string, number> | null;
  parentObservationId?: string | null;
}

export interface TraceDetails {
  id: string;
  observations: Observation[];
  scores: Array<{ name?: string | null; value?: number | null; comment?: string | null }>;
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
      const trace = (await client.api.traceGet(traceId)) as unknown as TraceDetails;
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

export const byName = (obs: Observation[], name: string): Observation | undefined =>
  obs.find((o) => o.name === name);

export const ofType = (obs: Observation[], type: string): Observation[] =>
  obs.filter((o) => o.type === type);
