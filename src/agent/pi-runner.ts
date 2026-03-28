import { Agent } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';
import { getToolsForAgent } from './tool-sets.js';
import { loadSystemPrompt } from './prompt-loader.js';
import { getModelForAgent } from './config.js';
import { parseAgentResult } from '../util/parse-agent-result.js';
import { createLogger } from '../util/logger.js';
import { sanitizeForTrace } from '../tracing/sanitize.js';
import type { AgentModelConfig, SpawnAgentOptions, SpawnAgentResult } from '../types.js';

const log = createLogger();

const registry = new ModelRegistry(AuthStorage.create());

export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const timeout = options.timeout ?? 600_000; // 10 min default
  const start = Date.now();

  const systemPrompt = await loadSystemPrompt(options.caseRoot, options.agentName);
  const tools = getToolsForAgent(options.agentName, options.cwd);

  // Priority: CLI --model override (env var) > explicit options > config file > defaults
  const modelOverride = process.env.CASE_MODEL_OVERRIDE;
  let modelConfig: AgentModelConfig;
  if (options.model) {
    modelConfig = { provider: options.provider ?? 'anthropic', model: options.model };
  } else if (modelOverride) {
    modelConfig = { provider: options.provider ?? 'anthropic', model: modelOverride };
  } else {
    modelConfig = await getModelForAgent(options.agentName);
  }

  const model = registry.find(modelConfig.provider, modelConfig.model);
  if (!model) {
    throw new Error(`Model not found: ${modelConfig.provider}/${modelConfig.model}. Check ~/.config/case/config.json`);
  }

  log.info('spawning agent', {
    agent: options.agentName,
    cwd: options.cwd,
    provider: modelConfig.provider,
    model: modelConfig.model,
    timeout,
  });

  const agent = new Agent({
    initialState: { systemPrompt, model, tools },
    streamFn: streamSimple,
  });

  // Collect full response text from streaming events and trace tool calls
  let responseText = '';
  const toolTimers = new Map<string, number>();

  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      responseText += event.assistantMessageEvent.delta;
    }
    if (event.type === 'tool_execution_start') {
      if (options.onHeartbeat) options.onHeartbeat(Date.now() - start);
      toolTimers.set(event.toolCallId, Date.now());
      if (options.traceWriter && options.phase) {
        options.traceWriter.write({
          ts: new Date().toISOString(),
          phase: options.phase,
          agent: options.agentName,
          event: 'tool_start',
          toolCallId: event.toolCallId,
          tool: event.toolName,
          args: sanitizeForTrace(event.args),
        });
      }
    }
    if (event.type === 'tool_execution_end') {
      const toolStart = toolTimers.get(event.toolCallId);
      toolTimers.delete(event.toolCallId);
      if (options.traceWriter && options.phase) {
        options.traceWriter.write({
          ts: new Date().toISOString(),
          phase: options.phase,
          agent: options.agentName,
          event: 'tool_end',
          toolCallId: event.toolCallId,
          tool: event.toolName,
          durationMs: toolStart ? Date.now() - toolStart : 0,
          isError: event.isError,
          result: sanitizeForTrace(event.result),
        });
      }
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
