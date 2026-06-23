/**
 * Langfuse dispatch (Phase 2.1).
 *
 * A per-run Langfuse trace (keyed by `runId`) fed from the single observability
 * seam in `pi-adapter.ts`. Each `spawn` opens one span (the phase); generations,
 * tool spans, and rubric scores nest under it.
 *
 * Hard invariants (RFC §1, §7):
 *   - Fire-and-forget. A dropped, slow, or unreachable Langfuse is a **no-op for
 *     orchestration** — every public method swallows its own errors and never
 *     throws into the control path.
 *   - The control path never reads back from Langfuse. This module is write-only.
 *   - Observability is dual until Phase 2.2: the JSONL appender keeps writing; this
 *     is additive.
 *
 * Disabled (returns `null` from {@link createLangfuseTracer}) when the public/secret
 * keys are absent — Case then runs exactly as before, JSONL-only.
 */
import { Langfuse } from 'langfuse';
import { createLogger } from '../util/logger.js';
import type { Rubric } from '../types.js';

const log = createLogger();

/**
 * Provider-neutral per-turn usage shape. Each runtime adapter maps its native
 * turn/result payload into this before calling {@link AgentSpan.generation}:
 *   - pi: `turn_end.message` already conforms structurally.
 *   - Claude Agent SDK: `result.usage` + `total_cost_usd` → this shape.
 *   - LangChain: `on_chat_model_end` `usage_metadata` → this shape.
 */
export interface GenerationUsage {
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  };
}

/** Per-spawn span handle. One per agent execution (= one phase node). */
export interface AgentSpan {
  /** One model turn → a generation observation carrying per-call tokens + cost. */
  generation(message: GenerationUsage): void;
  /** `tool_execution_start` → open a nested span. */
  toolStart(toolCallId: string, toolName: string, args: unknown): void;
  /** `tool_execution_end` → close the matching nested span. */
  toolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void;
  /** Domain event → a point-in-time `event()` observation. */
  event(name: string, data?: unknown): void;
  /** Verifier/reviewer rubric → one `score()` per category. */
  score(rubric: Rubric): void;
  /** `agent_end` / spawn return → close the phase span. */
  end(output?: unknown, isError?: boolean): void;
}

/** Run-scoped tracer. Created once per pipeline run, threaded via PipelineConfig. */
export interface LangfuseTracer {
  /** Open a phase span under the run trace. Always returns a usable (possibly no-op) handle. */
  startAgentSpan(agentName: string, phase?: string): AgentSpan;
  /**
   * Trace-level domain event (Phase 2.2). Orchestration-level events that have no
   * agent span — `revision_requested`, `revision_budget_exhausted`,
   * `fingerprint_match`, `scout_completed` — land on the run trace directly. These
   * used to be granular JSONL events; with the log gone they become trace events
   * so `ca watch` and the Langfuse UI still surface the revision/fingerprint story.
   * Self-defensive: never throws into the control path.
   */
  event(name: string, data?: unknown): void;
  /** Fire-and-forget flush — never awaited in the control path. */
  flushSafely(): void;
  /** Bounded flush at run end: races shutdown against a timeout so a hung sink can't block. */
  shutdownSafely(timeoutMs?: number): Promise<void>;
}

const NOOP_SPAN: AgentSpan = {
  generation() {},
  toolStart() {},
  toolEnd() {},
  event() {},
  score() {},
  end() {},
};

/** Map pi `usage` → Langfuse usageDetails/costDetails (snake_case keys, `total` summed by ingest). */
function mapUsage(usage: NonNullable<GenerationUsage['usage']>): {
  usageDetails: Record<string, number>;
  costDetails: Record<string, number>;
} {
  const usageDetails: Record<string, number> = {};
  if (typeof usage.input === 'number') usageDetails.input = usage.input;
  if (typeof usage.output === 'number') usageDetails.output = usage.output;
  if (typeof usage.cacheRead === 'number') usageDetails.cache_read = usage.cacheRead;
  if (typeof usage.cacheWrite === 'number') usageDetails.cache_write = usage.cacheWrite;
  if (typeof usage.totalTokens === 'number') usageDetails.total = usage.totalTokens;

  const costDetails: Record<string, number> = {};
  const cost = usage.cost;
  if (cost) {
    if (typeof cost.input === 'number') costDetails.input = cost.input;
    if (typeof cost.output === 'number') costDetails.output = cost.output;
    if (typeof cost.total === 'number') costDetails.total = cost.total;
  }
  return { usageDetails, costDetails };
}

export function createLangfuseTracer(runId: string, task: { id: string; title?: string }): LangfuseTracer | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  // No keys → disabled. JSONL observability is unaffected.
  if (!publicKey || !secretKey) return null;

  const baseUrl = process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASE_URL ?? 'http://localhost:3000';

  let client: Langfuse;
  let trace: ReturnType<Langfuse['trace']>;
  try {
    client = new Langfuse({ publicKey, secretKey, baseUrl });
    trace = client.trace({
      id: runId,
      name: `case-run:${task.id}`,
      metadata: { taskId: task.id, taskTitle: task.title, runId },
    });
  } catch (e) {
    // Construction must never break a run. Degrade to disabled.
    log.error('langfuse tracer init failed; observability degraded to JSONL-only', {
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  return {
    startAgentSpan(agentName, phase) {
      let span: ReturnType<typeof trace.span>;
      try {
        span = trace.span({
          name: phase ? `phase:${phase}` : `agent:${agentName}`,
          metadata: { agentName, phase },
        });
      } catch (e) {
        log.error('langfuse span open failed', { error: e instanceof Error ? e.message : String(e) });
        return NOOP_SPAN;
      }

      const toolSpans = new Map<string, ReturnType<typeof span.span>>();

      return {
        generation(message) {
          try {
            const usage = message.usage;
            const gen = span.generation({
              name: 'turn',
              model: message.model,
              ...(usage ? mapUsage(usage) : {}),
            });
            gen.end();
          } catch (e) {
            log.error('langfuse generation failed', { error: e instanceof Error ? e.message : String(e) });
          }
        },
        toolStart(toolCallId, toolName, args) {
          try {
            toolSpans.set(toolCallId, span.span({ name: `tool:${toolName}`, input: args }));
          } catch (e) {
            log.error('langfuse tool span open failed', { error: e instanceof Error ? e.message : String(e) });
          }
        },
        toolEnd(toolCallId, toolName, result, isError) {
          try {
            const toolSpan = toolSpans.get(toolCallId);
            toolSpans.delete(toolCallId);
            if (toolSpan) toolSpan.end({ output: result, level: isError ? 'ERROR' : 'DEFAULT' });
          } catch (e) {
            log.error('langfuse tool span close failed', { error: e instanceof Error ? e.message : String(e) });
          }
        },
        event(name, data) {
          try {
            span.event({ name, input: data });
          } catch (e) {
            log.error('langfuse event failed', { error: e instanceof Error ? e.message : String(e) });
          }
        },
        score(rubric) {
          try {
            for (const cat of rubric.categories) {
              span.score({
                name: `${rubric.role}:${cat.category}`,
                value: cat.verdict === 'pass' ? 1 : cat.verdict === 'fail' ? 0 : 0.5,
                comment: cat.detail,
              });
            }
          } catch (e) {
            log.error('langfuse score failed', { error: e instanceof Error ? e.message : String(e) });
          }
        },
        end(output, isError) {
          try {
            span.end({ output, level: isError ? 'ERROR' : 'DEFAULT' });
          } catch (e) {
            log.error('langfuse span close failed', { error: e instanceof Error ? e.message : String(e) });
          }
        },
      };
    },

    event(name, data) {
      try {
        trace.event({ name, input: data });
      } catch (e) {
        log.error('langfuse trace event failed', { error: e instanceof Error ? e.message : String(e) });
      }
    },

    flushSafely() {
      try {
        void client.flushAsync().catch((e: unknown) => {
          log.error('langfuse flush failed', { error: e instanceof Error ? e.message : String(e) });
        });
      } catch (e) {
        log.error('langfuse flush threw', { error: e instanceof Error ? e.message : String(e) });
      }
    },

    async shutdownSafely(timeoutMs = 3000) {
      try {
        await Promise.race([client.shutdownAsync(), new Promise<void>((res) => setTimeout(res, timeoutMs))]);
      } catch (e) {
        log.error('langfuse shutdown failed', { error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
