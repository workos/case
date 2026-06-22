/**
 * LangChain runtime — executes non-Claude models (OpenAI, Google, …) via
 * `createReactAgent` from the installed `@langchain/langgraph` prebuilt. Selected
 * by {@link ProviderRoutingRuntime} whenever the resolved model is NOT a Claude
 * family member.
 *
 * It pairs a provider chat model (`chatModelFor`) with the LangChain agent tools
 * (`createLangchainTools`, gated by `toolPolicyFor`) and drives the tool loop via
 * `streamEvents` (v2), translating model/tool events into the same Langfuse span
 * + renderer callbacks every other runtime emits.
 */
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { loadSystemPrompt } from '../prompt-loader.js';
import { resolveAgentModel } from '../config.js';
import { createLangchainTools } from '../tools/langchain/index.js';
import { parseAgentResult } from '../../util/parse-agent-result.js';
import { createLogger } from '../../util/logger.js';
import { sanitizeForTrace } from '../../tracing/sanitize.js';
import { failedSpawnResult, notifyToolEnd, notifyToolStart } from './spawn-shared.js';
import type { SpawnAgentOptions, SpawnAgentResult } from '../../types.js';
import type { CaseAgentRuntime, WorkspacePolicy } from '../runtime.js';

const log = createLogger();

const RECURSION_LIMIT = 100;

/** Build a provider chat model from a resolved `{provider, model}`. */
function chatModelFor(provider: string, model: string): BaseChatModel {
  const p = provider.toLowerCase();
  if (p === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('LangChain runtime: OPENAI_API_KEY is not set');
    return new ChatOpenAI({ model, apiKey });
  }
  if (p === 'google' || p === 'google-genai' || p === 'gemini') {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('LangChain runtime: GOOGLE_API_KEY is not set');
    return new ChatGoogleGenerativeAI({ model, apiKey });
  }
  if (p === 'openrouter') {
    // OpenRouter is OpenAI-compatible: one endpoint fronts every provider's
    // models (ids are prefixed, e.g. `google/gemini-2.5-pro`, `openai/gpt-4o`).
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('LangChain runtime: OPENROUTER_API_KEY is not set');
    return new ChatOpenAI({
      model,
      apiKey,
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        // App attribution for OpenRouter's leaderboard (optional; cosmetic).
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/workos/case',
          'X-Title': 'Case Harness',
        },
      },
    });
  }
  throw new Error(
    `LangChain runtime: unsupported provider "${provider}". Supported: openai, google, openrouter. ` +
      `(Claude models route to the Agent SDK runtime.)`,
  );
}

/** Coerce message content (string | content blocks) to plain text. */
function textOf(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => (typeof block === 'string' ? block : ((block as { text?: string }).text ?? '')))
    .join('');
}

export class LangChainRuntime implements CaseAgentRuntime {
  private abortController: AbortController | null = null;

  async spawn(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
    const timeout = options.timeout ?? 600_000;
    const start = Date.now();

    const systemPrompt = await loadSystemPrompt(options.packageRoot, options.agentName);
    const modelConfig = await resolveAgentModel(options);

    log.info('spawning agent', {
      agent: options.agentName,
      runtime: 'langchain',
      cwd: options.cwd,
      provider: modelConfig.provider,
      model: modelConfig.model,
      timeout,
    });

    const span = options.langfuse?.startAgentSpan(options.agentName, options.phase);
    const abortController = new AbortController();
    this.abortController = abortController;
    const timer = setTimeout(() => abortController.abort(), timeout);

    // run_id → { name, startedAt } for tool start/end pairing.
    const toolRuns = new Map<string, { name: string; startedAt: number }>();
    let responseText = '';

    try {
      const llm = chatModelFor(modelConfig.provider, modelConfig.model);
      const tools = createLangchainTools(options.agentName, options.cwd);
      const agent = createReactAgent({ llm, tools, prompt: systemPrompt });

      const stream = agent.streamEvents(
        { messages: [new HumanMessage(options.prompt)] },
        { version: 'v2', signal: abortController.signal, recursionLimit: RECURSION_LIMIT },
      );

      for await (const ev of stream) {
        if (ev.event === 'on_chat_model_end') {
          const output = ev.data?.output as
            | {
                content?: BaseMessage['content'];
                usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
              }
            | undefined;
          if (output?.content !== undefined) responseText += textOf(output.content);
          const usage = output?.usage_metadata;
          span?.generation({
            model: modelConfig.model,
            usage: {
              input: usage?.input_tokens,
              output: usage?.output_tokens,
              totalTokens: usage?.total_tokens,
            },
          });
        } else if (ev.event === 'on_tool_start') {
          toolRuns.set(ev.run_id, { name: ev.name, startedAt: Date.now() });
          const sanitizedArgs = notifyToolStart(options, ev.name, ev.data?.input, Date.now() - start);
          span?.toolStart(ev.run_id, ev.name, sanitizedArgs);
        } else if (ev.event === 'on_tool_end') {
          const meta = toolRuns.get(ev.run_id);
          toolRuns.delete(ev.run_id);
          const durationMs = meta ? Date.now() - meta.startedAt : 0;
          const toolName = meta?.name ?? ev.name;
          span?.toolEnd(ev.run_id, toolName, sanitizeForTrace(ev.data?.output), false);
          notifyToolEnd(options, toolName, durationMs, false);
        }
      }

      clearTimeout(timer);
      this.abortController = null;
      const durationMs = Date.now() - start;

      const result = parseAgentResult(responseText);
      log.info('agent completed', { agent: options.agentName, durationMs, status: result.status });

      if (result.rubric) span?.score(result.rubric);
      span?.end({ status: result.status, summary: result.summary }, result.status === 'failed');

      return { raw: responseText, result, durationMs };
    } catch (err) {
      clearTimeout(timer);
      this.abortController = null;
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error('agent spawn failed', { agent: options.agentName, durationMs, error: errorMsg });
      span?.end({ error: errorMsg }, true);
      return failedSpawnResult(`Agent spawn error: ${errorMsg}`, durationMs);
    }
  }

  createTools(agentName: string, cwd: string, _policy?: WorkspacePolicy): unknown[] {
    return createLangchainTools(agentName, cwd);
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
