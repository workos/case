/**
 * Provider-routing runtime — the default {@link CaseAgentRuntime} for the
 * pipeline (wired at pipeline.ts). Per spawn it resolves the effective model and
 * dispatches to the matching backend:
 *
 *   provider `copilot` → CopilotSdkRuntime      (GitHub Copilot subscription)
 *   Claude model      → ClaudeAgentSdkRuntime  (subscription/OAuth, resource win)
 *   everything else   → LangChainRuntime       (createReactAgent + provider model)
 *
 * Routing is driven entirely by the resolved `{provider, model}` — set an agent's
 * model in config and the runtime follows; no separate selection knob. Copilot is
 * matched first by explicit provider (it fronts both GPT and Claude model ids, so
 * a name heuristic would collide with the other backends). The `CASE_AGENT_RUNTIME`
 * env (`pi` | `sdk` | `langchain` | `copilot`) is an explicit override for
 * debugging or forcing a single backend.
 *
 * Backends are constructed lazily so a run that only touches Claude models never
 * pays to instantiate the LangChain stack (and vice-versa).
 */
import { isClaudeModel, isCopilotProvider, resolveAgentModel } from '../config.js';
import { ClaudeAgentSdkRuntime } from './claude-agent-sdk-adapter.js';
import { CopilotSdkRuntime } from './copilot-sdk-adapter.js';
import { LangChainRuntime } from './langchain-adapter.js';
import { PiRuntimeAdapter } from './pi-adapter.js';
import { createLogger } from '../../util/logger.js';
import type { SpawnAgentOptions, SpawnAgentResult } from '../../types.js';
import type { CaseAgentRuntime, WorkspacePolicy } from '../runtime.js';

const log = createLogger();

type ForcedRuntime = 'pi' | 'sdk' | 'langchain' | 'copilot';

export class ProviderRoutingRuntime implements CaseAgentRuntime {
  private sdk: ClaudeAgentSdkRuntime | null = null;
  private langchain: LangChainRuntime | null = null;
  private pi: PiRuntimeAdapter | null = null;
  private copilot: CopilotSdkRuntime | null = null;
  /** Last runtime a spawn delegated to — abort()/createTools target it. */
  private active: CaseAgentRuntime | null = null;

  private getSdk(): ClaudeAgentSdkRuntime {
    return (this.sdk ??= new ClaudeAgentSdkRuntime());
  }
  private getLangchain(): LangChainRuntime {
    return (this.langchain ??= new LangChainRuntime());
  }
  private getPi(): PiRuntimeAdapter {
    return (this.pi ??= new PiRuntimeAdapter());
  }
  private getCopilot(): CopilotSdkRuntime {
    return (this.copilot ??= new CopilotSdkRuntime());
  }

  private forced(): ForcedRuntime | null {
    const v = process.env.CASE_AGENT_RUNTIME?.toLowerCase();
    return v === 'pi' || v === 'sdk' || v === 'langchain' || v === 'copilot' ? v : null;
  }

  /** Pick the backend for a spawn: env override first, then model provider. */
  private async select(options: SpawnAgentOptions): Promise<CaseAgentRuntime> {
    const forced = this.forced();
    if (forced === 'pi') return this.getPi();
    if (forced === 'sdk') return this.getSdk();
    if (forced === 'langchain') return this.getLangchain();
    if (forced === 'copilot') return this.getCopilot();

    const model = await resolveAgentModel(options);
    // Copilot is matched first by explicit provider — it fronts both GPT and
    // Claude model ids, so isClaudeModel would otherwise capture copilot/claude-*.
    if (isCopilotProvider(model)) return this.getCopilot();
    return isClaudeModel(model) ? this.getSdk() : this.getLangchain();
  }

  async spawn(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
    // Resolve once here so the chosen backend gets an explicit model and skips
    // re-resolution (and so routing + execution can never disagree).
    const model = await resolveAgentModel(options);
    const runtime = await this.select(options);
    this.active = runtime;
    log.info('routing spawn', {
      agent: options.agentName,
      provider: model.provider,
      model: model.model,
      backend: runtime.constructor.name,
    });
    return runtime.spawn({ ...options, provider: model.provider, model: model.model });
  }

  createTools(agentName: string, cwd: string, policy?: WorkspacePolicy): unknown[] {
    return (this.active ?? this.getPi()).createTools(agentName, cwd, policy);
  }

  abort(): void {
    this.active?.abort();
  }
}
