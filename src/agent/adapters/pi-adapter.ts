import { Agent } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import {
  AuthStorage,
  ModelRegistry,
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
} from '@mariozechner/pi-coding-agent';
import { loadSystemPrompt } from '../prompt-loader.js';
import { getModelForAgent } from '../config.js';
import { parseAgentResult } from '../../util/parse-agent-result.js';
import { createLogger } from '../../util/logger.js';
import { sanitizeForTrace } from '../../tracing/sanitize.js';
import type { AgentModelConfig, SpawnAgentOptions, SpawnAgentResult } from '../../types.js';
import type { CaseAgentRuntime, WorkspacePolicy } from '../runtime.js';

const log = createLogger();

export class PiRuntimeAdapter implements CaseAgentRuntime {
  private registry: ModelRegistry;
  private activeAgent: Agent | null = null;

  constructor() {
    this.registry = new ModelRegistry(AuthStorage.create());
  }

  async spawn(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
    const timeout = options.timeout ?? 600_000;
    const start = Date.now();

    // Agent prompt templates are package assets: disk override in dev, embedded in binaries.
    const systemPrompt = await loadSystemPrompt(options.packageRoot, options.agentName);
    const tools = this.createPiTools(options.agentName, options.cwd);

    const modelOverride = process.env.CASE_MODEL_OVERRIDE;
    let modelConfig: AgentModelConfig;
    if (options.model) {
      modelConfig = { provider: options.provider ?? 'anthropic', model: options.model };
    } else if (modelOverride) {
      modelConfig = { provider: options.provider ?? 'anthropic', model: modelOverride };
    } else {
      modelConfig = await getModelForAgent(options.agentName);
    }

    const model = this.registry.find(modelConfig.provider, modelConfig.model);
    if (!model) {
      throw new Error(
        `Model not found: ${modelConfig.provider}/${modelConfig.model}. Check ~/.config/case/config.json`,
      );
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
    this.activeAgent = agent;

    let responseText = '';
    const toolTimers = new Map<string, number>();

    agent.subscribe((event: any) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        responseText += event.assistantMessageEvent.delta;
      }
      if (event.type === 'tool_execution_start') {
        if (options.onHeartbeat) options.onHeartbeat(Date.now() - start);
        toolTimers.set(event.toolCallId, Date.now());
        const sanitizedArgs = sanitizeForTrace(event.args);
        // Renderer hook — wrap in try/catch so rendering bugs never kill the agent.
        if (options.onToolActivity) {
          try {
            options.onToolActivity({
              type: 'start',
              tool: event.toolName,
              args: typeof sanitizedArgs === 'string' ? sanitizedArgs : JSON.stringify(sanitizedArgs),
            });
          } catch (e) {
            log.error('onToolActivity start callback threw', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        if (options.phase) {
          const toolEvent = {
            event: 'tool_start' as const,
            phase: options.phase,
            agent: options.agentName,
            toolCallId: event.toolCallId,
            tool: event.toolName,
            args: sanitizedArgs,
          };
          if (options.eventAppender) {
            void options.eventAppender.append(toolEvent);
          } else if (options.traceWriter) {
            options.traceWriter.write({ ts: new Date().toISOString(), ...toolEvent });
          }
        }
      }
      if (event.type === 'tool_execution_end') {
        const toolStart = toolTimers.get(event.toolCallId);
        toolTimers.delete(event.toolCallId);
        const durationMs = toolStart ? Date.now() - toolStart : 0;
        if (options.onToolActivity) {
          try {
            options.onToolActivity({
              type: 'end',
              tool: event.toolName,
              durationMs,
              isError: event.isError,
            });
          } catch (e) {
            log.error('onToolActivity end callback threw', {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        if (options.phase) {
          const toolEvent = {
            event: 'tool_end' as const,
            phase: options.phase,
            agent: options.agentName,
            toolCallId: event.toolCallId,
            tool: event.toolName,
            durationMs,
            isError: event.isError,
            result: sanitizeForTrace(event.result),
          };
          if (options.eventAppender) {
            void options.eventAppender.append(toolEvent);
          } else if (options.traceWriter) {
            options.traceWriter.write({ ts: new Date().toISOString(), ...toolEvent });
          }
        }
      }
    });

    const timer = setTimeout(() => agent.abort(), timeout);

    try {
      await agent.prompt(options.prompt);
      clearTimeout(timer);
      this.activeAgent = null;
      const durationMs = Date.now() - start;

      const result = parseAgentResult(responseText);
      log.info('agent completed', { agent: options.agentName, durationMs, status: result.status });

      return { raw: responseText, result, durationMs };
    } catch (err) {
      clearTimeout(timer);
      this.activeAgent = null;
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

  createTools(agentName: string, cwd: string, _policy?: WorkspacePolicy): unknown[] {
    return this.createPiTools(agentName, cwd);
  }

  private createPiTools(agentName: string, cwd: string) {
    switch (agentName) {
      case 'implementer':
      case 'retrospective':
        return [createReadTool(cwd), createWriteTool(cwd), createEditTool(cwd), createBashTool(cwd)];
      case 'verifier':
      case 'reviewer':
      case 'closer':
      default:
        return [createReadTool(cwd), createBashTool(cwd)];
    }
  }

  abort(): void {
    if (this.activeAgent) {
      this.activeAgent.abort();
      this.activeAgent = null;
    }
  }
}
