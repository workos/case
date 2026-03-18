import { Agent } from '@mariozechner/pi-agent-core';
import { streamSimple, getModel } from '@mariozechner/pi-ai';
import { getToolsForAgent } from './tool-sets.js';
import { loadSystemPrompt } from './prompt-loader.js';
import { parseAgentResult } from '../util/parse-agent-result.js';
import { createLogger } from '../util/logger.js';
import type { SpawnAgentOptions, SpawnAgentResult } from '../types.js';

const log = createLogger();

export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const timeout = options.timeout ?? 600_000; // 10 min default
  const start = Date.now();

  const systemPrompt = await loadSystemPrompt(options.caseRoot, options.agentName);
  const tools = getToolsForAgent(options.agentName, options.cwd);
  // as any: getModel expects string literal types (KnownProvider, model ID) but
  // our config uses plain strings. Pi validates at runtime and throws if invalid.
  const model = getModel(
    (options.provider ?? 'anthropic') as any,
    (options.model ?? 'claude-sonnet-4-20250514') as any,
  );

  log.info('spawning agent', {
    agent: options.agentName,
    cwd: options.cwd,
    provider: options.provider ?? 'anthropic',
    model: options.model ?? 'claude-sonnet-4-20250514',
    timeout,
  });

  const agent = new Agent({
    initialState: { systemPrompt, model, tools },
    streamFn: streamSimple,
  });

  // Collect full response text from streaming events
  let responseText = '';
  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      responseText += event.assistantMessageEvent.delta;
    }
    if (event.type === 'tool_execution_start' && options.onHeartbeat) {
      options.onHeartbeat(Date.now() - start);
    }
  });

  // Timeout: abort the agent after the configured duration
  const timer = setTimeout(() => agent.abort(), timeout);

  try {
    await agent.prompt(options.prompt);
    clearTimeout(timer);
    const durationMs = Date.now() - start;

    const result = parseAgentResult(responseText);
    log.info('agent completed', { agent: options.agentName, durationMs, status: result.status });

    return { raw: responseText, result, durationMs };
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);

    log.error('agent spawn failed', { agent: options.agentName, durationMs, error: errorMsg });

    return {
      raw: '',
      result: {
        status: 'failed',
        summary: '',
        artifacts: {
          commit: null,
          filesChanged: [],
          testsPassed: null,
          screenshotUrls: [],
          evidenceMarkers: [],
          prUrl: null,
          prNumber: null,
        },
        error: `Agent spawn error: ${errorMsg}`,
      },
      durationMs,
    };
  }
}
