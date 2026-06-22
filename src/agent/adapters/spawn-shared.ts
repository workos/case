/**
 * Shared spawn helpers used by every {@link CaseAgentRuntime} adapter
 * (pi / Claude Agent SDK / LangChain). Keeps the failed-result shape and the
 * tool-activity / heartbeat callback fan-out identical across runtimes so a
 * phase behaves the same regardless of which backend executed it.
 */
import { sanitizeForTrace } from '../../tracing/sanitize.js';
import { createLogger } from '../../util/logger.js';
import type { AgentResult, SpawnAgentOptions, SpawnAgentResult } from '../../types.js';

const log = createLogger();

const EMPTY_ARTIFACTS: AgentResult['artifacts'] = {
  commit: null,
  filesChanged: [],
  testsPassed: null,
  screenshotUrls: [],
  evidenceMarkers: [],
  prUrl: null,
  prNumber: null,
};

/** A synthetic `failed` AgentResult (used when a spawn throws before/while running). */
export function failedAgentResult(error: string): AgentResult {
  return {
    status: 'failed',
    summary: '',
    artifacts: { ...EMPTY_ARTIFACTS },
    error,
  };
}

/** Full `SpawnAgentResult` wrapper for a spawn-level failure. */
export function failedSpawnResult(error: string, durationMs: number): SpawnAgentResult {
  return { raw: '', result: failedAgentResult(error), durationMs };
}

/**
 * Fire the renderer's tool-start hook + heartbeat. Mirrors pi-adapter exactly:
 * args are sanitized for trace, and the renderer callback is wrapped so a
 * rendering bug can never kill the agent. Returns the sanitized args so the
 * caller can forward the same value to its Langfuse span.
 */
export function notifyToolStart(
  options: SpawnAgentOptions,
  toolName: string,
  rawArgs: unknown,
  elapsedMs: number,
): unknown {
  const sanitizedArgs = sanitizeForTrace(rawArgs);
  if (options.onHeartbeat) options.onHeartbeat(elapsedMs);
  if (options.onToolActivity) {
    try {
      options.onToolActivity({
        type: 'start',
        tool: toolName,
        args: typeof sanitizedArgs === 'string' ? sanitizedArgs : JSON.stringify(sanitizedArgs),
      });
    } catch (e) {
      log.error('onToolActivity start callback threw', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return sanitizedArgs;
}

/** Fire the renderer's tool-end hook (wrapped, never throws into the agent loop). */
export function notifyToolEnd(
  options: SpawnAgentOptions,
  toolName: string,
  durationMs: number,
  isError: boolean,
): void {
  if (options.onToolActivity) {
    try {
      options.onToolActivity({ type: 'end', tool: toolName, durationMs, isError });
    } catch (e) {
      log.error('onToolActivity end callback threw', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
