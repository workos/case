/**
 * Claude Agent SDK runtime — executes Anthropic (Claude) models via
 * `@anthropic-ai/claude-agent-sdk`. Selected by {@link ProviderRoutingRuntime}
 * whenever the resolved model is a Claude family member.
 *
 * Why this exists alongside pi: the Agent SDK runs against Claude Code
 * subscription credentials (OAuth), not per-token API billing — the resource /
 * cost win that motivated provider-routed runtimes. It also brings the SDK's
 * built-in prompt caching and context compaction for free.
 *
 * Tool surface mirrors pi exactly via `toolPolicyFor`: read-only roles get
 * Read + Bash (+ Grep/Glob), mutable roles additionally get Write + Edit. The
 * pipeline is autonomous, so permission prompts are bypassed.
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSystemPrompt } from '../prompt-loader.js';
import { resolveAgentModel, toolPolicyFor } from '../config.js';
import { parseAgentResult } from '../../util/parse-agent-result.js';
import { createLogger } from '../../util/logger.js';
import { sanitizeForTrace } from '../../tracing/sanitize.js';
import { failedSpawnResult, notifyToolEnd, notifyToolStart } from './spawn-shared.js';
import type { SpawnAgentOptions, SpawnAgentResult } from '../../types.js';
import type { CaseAgentRuntime, WorkspacePolicy } from '../runtime.js';

const log = createLogger();

/** Read-only tool allowlist (no Write/Edit). Bash covers rg/find for exploration. */
const READ_ONLY_TOOLS = ['Read', 'Bash', 'Grep', 'Glob'];
/** Mutable roles add file mutation on top of the read-only set. */
const MUTABLE_TOOLS = [...READ_ONLY_TOOLS, 'Write', 'Edit'];

/**
 * True when the SDK has subscription/OAuth credentials available. We prefer
 * OAuth (the resource win) and never require ANTHROPIC_API_KEY. Sources, in the
 * order the SDK itself resolves them: the CLAUDE_CODE_OAUTH_TOKEN env, or stored
 * Claude Code credentials under ~/.claude.
 */
function hasSubscriptionAuth(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  const credPath = join(homedir(), '.claude', '.credentials.json');
  return existsSync(credPath);
}

export class ClaudeAgentSdkRuntime implements CaseAgentRuntime {
  private abortController: AbortController | null = null;

  async spawn(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
    const timeout = options.timeout ?? 600_000;
    const start = Date.now();

    if (!hasSubscriptionAuth() && !process.env.ANTHROPIC_API_KEY) {
      // Fail fast with an actionable message rather than letting the SDK throw an
      // opaque auth error mid-stream. OAuth is the intended (subscription) path.
      const msg =
        'Claude Agent SDK: no credentials. Run `claude` to log in (subscription/OAuth) ' +
        'or set CLAUDE_CODE_OAUTH_TOKEN. (ANTHROPIC_API_KEY also works but bills per token.)';
      log.error('agent spawn failed', { agent: options.agentName, error: msg });
      return failedSpawnResult(msg, Date.now() - start);
    }

    const systemPrompt = await loadSystemPrompt(options.packageRoot, options.agentName);
    const modelConfig = await resolveAgentModel(options);
    const policy = toolPolicyFor(options.agentName);

    log.info('spawning agent', {
      agent: options.agentName,
      runtime: 'claude-agent-sdk',
      cwd: options.cwd,
      provider: modelConfig.provider,
      model: modelConfig.model,
      timeout,
    });

    const span = options.langfuse?.startAgentSpan(options.agentName, options.phase);

    const abortController = new AbortController();
    this.abortController = abortController;
    const timer = setTimeout(() => abortController.abort(), timeout);

    // Map a tool_use_id → { name, startedAt } so tool_result frames can be paired
    // back to their originating tool_use for timing + span correlation.
    const pending = new Map<string, { name: string; startedAt: number }>();
    let responseText = '';

    const sdkOptions: Options = {
      model: modelConfig.model,
      // Plain-string systemPrompt fully replaces the SDK's default agent prompt
      // with our role prompt — the same prompt pi loads.
      systemPrompt,
      cwd: options.cwd,
      allowedTools: policy === 'mutable' ? MUTABLE_TOOLS : READ_ONLY_TOOLS,
      disallowedTools: policy === 'mutable' ? [] : ['Write', 'Edit'],
      // Autonomous pipeline: no human to approve tool use.
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController,
    };

    try {
      for await (const message of query({ prompt: options.prompt, options: sdkOptions })) {
        this.handleMessage(message, options, span, pending, start, (text) => {
          responseText += text;
        });
        // A result frame carries the canonical final text + usage; capture it.
        if (message.type === 'result') {
          if (message.subtype === 'success') responseText = message.result || responseText;
          span?.generation({
            model: modelConfig.model,
            usage: {
              input: message.usage?.input_tokens,
              output: message.usage?.output_tokens,
              cacheRead: message.usage?.cache_read_input_tokens,
              cacheWrite: message.usage?.cache_creation_input_tokens,
              cost: { total: message.total_cost_usd },
            },
          });
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

  /** Translate one SDK message into span events, callbacks, and accumulated text. */
  private handleMessage(
    message: SDKMessage,
    options: SpawnAgentOptions,
    span: ReturnType<NonNullable<SpawnAgentOptions['langfuse']>['startAgentSpan']> | undefined,
    pending: Map<string, { name: string; startedAt: number }>,
    start: number,
    appendText: (text: string) => void,
  ): void {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          appendText(block.text);
        } else if (block.type === 'tool_use') {
          pending.set(block.id, { name: block.name, startedAt: Date.now() });
          const sanitizedArgs = notifyToolStart(options, block.name, block.input, Date.now() - start);
          span?.toolStart(block.id, block.name, sanitizedArgs);
        }
      }
      return;
    }
    // tool_result blocks arrive as user messages echoing the tool output.
    if (message.type === 'user') {
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result') {
          const tr = block as { tool_use_id: string; content?: unknown; is_error?: boolean };
          const meta = pending.get(tr.tool_use_id);
          pending.delete(tr.tool_use_id);
          const durationMs = meta ? Date.now() - meta.startedAt : 0;
          const toolName = meta?.name ?? 'tool';
          span?.toolEnd(tr.tool_use_id, toolName, sanitizeForTrace(tr.content), tr.is_error ?? false);
          notifyToolEnd(options, toolName, durationMs, tr.is_error ?? false);
        }
      }
    }
  }

  createTools(_agentName: string, _cwd: string, _policy?: WorkspacePolicy): unknown[] {
    // The Agent SDK owns its built-in tools; selection happens via the allow/deny
    // lists in spawn(). Nothing to construct here.
    return [];
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
