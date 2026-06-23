/**
 * GitHub Copilot SDK runtime — executes models through a GitHub Copilot
 * subscription via `@github/copilot-sdk`. Selected by {@link ProviderRoutingRuntime}
 * whenever the resolved model's provider is `copilot`.
 *
 * Why it sits beside the Claude Agent SDK runtime rather than under LangChain:
 * the Copilot SDK is *agentic* — it drives the bundled Copilot CLI, which owns
 * its own file/shell tools and runs against the user's Copilot subscription
 * (the logged-in `copilot` CLI user / GitHub OAuth), not per-token API billing.
 * That is the same subscription/resource win the Claude SDK runtime exists for.
 *
 * Copilot serves both GPT and Claude model ids, so routing here is by explicit
 * provider (`copilot`) only — never a model-name heuristic, which would collide
 * with the Claude-SDK and LangChain backends.
 *
 * Tool surface mirrors the other runtimes via `toolPolicyFor`: read-only roles
 * may read and run shell exploration but never write the tree; mutable roles
 * (implementer/retrospective) may write. Enforced through the SDK's
 * `onPermissionRequest` callback — the Copilot CLI's permission seam — rather
 * than an allow/deny list. Read-only roles reject `write` permission requests;
 * shell stays allowed (they run rg/find/git-status), matching pi and the Agent SDK.
 */
import {
  CopilotClient,
  approveAll,
  type CopilotSession,
  type PermissionHandler,
  type SessionEvent,
} from '@github/copilot-sdk';
import { loadSystemPrompt } from '../prompt-loader.js';
import { resolveAgentModel, toolPolicyFor } from '../config.js';
import { parseAgentResult } from '../../util/parse-agent-result.js';
import { createLogger } from '../../util/logger.js';
import { sanitizeForTrace } from '../../tracing/sanitize.js';
import { failedSpawnResult, notifyToolEnd, notifyToolStart } from './spawn-shared.js';
import type { SpawnAgentOptions, SpawnAgentResult } from '../../types.js';
import type { CaseAgentRuntime, WorkspacePolicy } from '../runtime.js';

const log = createLogger();

/**
 * Build the permission handler that enforces a workspace policy. Mutable roles
 * approve every tool call; read-only roles approve everything except `write`
 * requests (file mutations) — the same Read+Bash / no-Write-Edit surface the
 * Agent SDK and pi runtimes expose for scout/verifier/reviewer/closer. Shell is
 * intentionally allowed for read-only roles: they run rg/find/git-status.
 */
function permissionHandlerFor(policy: WorkspacePolicy): PermissionHandler {
  if (policy === 'mutable') return approveAll;
  return (request) =>
    request.kind === 'write'
      ? { kind: 'reject', feedback: 'read-only agent: file mutations are not permitted' }
      : { kind: 'approve-once' };
}

export class CopilotSdkRuntime implements CaseAgentRuntime {
  private session: CopilotSession | null = null;
  private client: CopilotClient | null = null;

  async spawn(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
    const timeout = options.timeout ?? 600_000;
    const start = Date.now();

    const systemPrompt = await loadSystemPrompt(options.packageRoot, options.agentName);
    const modelConfig = await resolveAgentModel(options);
    const policy = toolPolicyFor(options.agentName);

    log.info('spawning agent', {
      agent: options.agentName,
      runtime: 'copilot-sdk',
      cwd: options.cwd,
      provider: modelConfig.provider,
      model: modelConfig.model,
      timeout,
    });

    const span = options.langfuse?.startAgentSpan(options.agentName, options.phase);

    // The bundled Copilot CLI authenticates as the logged-in user (subscription)
    // by default; an explicit GITHUB_TOKEN/GH_TOKEN wins when present (CI).
    const client = new CopilotClient({
      workingDirectory: options.cwd,
      useLoggedInUser: true,
      gitHubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
      logLevel: 'none',
    });
    this.client = client;

    // Map a toolCallId → { name, startedAt } so tool.execution_complete frames
    // (which carry no toolName) can be paired back to their start for timing.
    const pending = new Map<string, { name: string; startedAt: number }>();
    let responseText = '';

    try {
      await client.start();

      // Fail fast with an actionable message rather than letting the first
      // message throw an opaque auth error mid-stream.
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) {
        const msg =
          'GitHub Copilot SDK: not authenticated. Run `copilot` (the bundled CLI) to log in ' +
          'with your Copilot subscription, or set GITHUB_TOKEN/GH_TOKEN.';
        log.error('agent spawn failed', { agent: options.agentName, error: msg });
        await client.stop().catch(() => {});
        this.client = null;
        span?.end({ error: msg }, true);
        return failedSpawnResult(msg, Date.now() - start);
      }

      const session = await client.createSession({
        model: modelConfig.model,
        streaming: true,
        // Replace mode fully substitutes Copilot's default agent prompt with our
        // role prompt — the same prompt pi and the Agent SDK runtime load.
        systemMessage: { mode: 'replace', content: systemPrompt },
        onPermissionRequest: permissionHandlerFor(policy),
      });
      this.session = session;

      session.on((event) =>
        this.handleEvent(event, options, span, pending, start, modelConfig.model, (text) => {
          responseText += text;
        }),
      );

      // sendAndWait blocks until the session goes idle; its terminal assistant
      // message carries the canonical final text. Fall back to the accumulated
      // streaming deltas if the SDK returned no terminal message.
      const final = await session.sendAndWait({ prompt: options.prompt }, timeout);
      if (final?.data.content) responseText = final.data.content;

      await session.disconnect().catch(() => {});
      this.session = null;
      await client.stop().catch(() => {});
      this.client = null;

      const durationMs = Date.now() - start;
      const result = parseAgentResult(responseText);
      log.info('agent completed', { agent: options.agentName, durationMs, status: result.status });

      if (result.rubric) span?.score(result.rubric);
      span?.end({ status: result.status, summary: result.summary }, result.status === 'failed');

      return { raw: responseText, result, durationMs };
    } catch (err) {
      await this.session?.disconnect().catch(() => {});
      this.session = null;
      await this.client?.stop().catch(() => {});
      this.client = null;
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error('agent spawn failed', { agent: options.agentName, durationMs, error: errorMsg });
      span?.end({ error: errorMsg }, true);
      return failedSpawnResult(`Agent spawn error: ${errorMsg}`, durationMs);
    }
  }

  /** Translate one Copilot session event into span events, callbacks, and text. */
  private handleEvent(
    event: SessionEvent,
    options: SpawnAgentOptions,
    span: ReturnType<NonNullable<SpawnAgentOptions['langfuse']>['startAgentSpan']> | undefined,
    pending: Map<string, { name: string; startedAt: number }>,
    start: number,
    model: string,
    appendText: (text: string) => void,
  ): void {
    switch (event.type) {
      case 'assistant.message_delta':
        appendText(event.data.deltaContent ?? '');
        break;
      case 'assistant.usage':
        span?.generation({
          model,
          usage: {
            input: event.data.inputTokens,
            output: event.data.outputTokens,
            cacheRead: event.data.cacheReadTokens,
            cacheWrite: event.data.cacheWriteTokens,
            cost: { total: event.data.cost },
          },
        });
        break;
      case 'tool.execution_start': {
        const { toolCallId, toolName, arguments: args } = event.data;
        pending.set(toolCallId, { name: toolName, startedAt: Date.now() });
        const sanitizedArgs = notifyToolStart(options, toolName, args, Date.now() - start);
        span?.toolStart(toolCallId, toolName, sanitizedArgs);
        break;
      }
      case 'tool.execution_complete': {
        const { toolCallId, success, error, result } = event.data;
        const meta = pending.get(toolCallId);
        pending.delete(toolCallId);
        const durationMs = meta ? Date.now() - meta.startedAt : 0;
        const toolName = meta?.name ?? 'tool';
        const isError = !success;
        span?.toolEnd(toolCallId, toolName, sanitizeForTrace(error ?? result), isError);
        notifyToolEnd(options, toolName, durationMs, isError);
        break;
      }
      case 'session.error':
        log.error('copilot session error', {
          agent: options.agentName,
          error: event.data?.message,
        });
        break;
    }
  }

  createTools(_agentName: string, _cwd: string, _policy?: WorkspacePolicy): unknown[] {
    // The Copilot CLI owns its built-in tools; the workspace policy is enforced
    // through onPermissionRequest in spawn(). Nothing to construct here.
    return [];
  }

  abort(): void {
    void this.session?.abort().catch(() => {});
    void this.client?.stop().catch(() => {});
    this.session = null;
    this.client = null;
  }
}
