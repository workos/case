import type { AgentModelConfig } from '../types.js';
import type { WorkspacePolicy } from './runtime.js';
import { resolveConfigPath } from '../paths.js';

interface CaseConfig {
  models?: {
    default?: AgentModelConfig;
    implementer?: AgentModelConfig | null;
    reviewer?: AgentModelConfig | null;
    verifier?: AgentModelConfig | null;
    closer?: AgentModelConfig | null;
    retrospective?: AgentModelConfig | null;
    orchestrator?: AgentModelConfig | null;
  };
}

const DEFAULT_MODEL: AgentModelConfig = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
};

export async function loadConfig(): Promise<CaseConfig> {
  try {
    const raw = await Bun.file(resolveConfigPath()).text();
    return JSON.parse(raw) as CaseConfig;
  } catch {
    return {};
  }
}

export async function getModelForAgent(agentName: string): Promise<AgentModelConfig> {
  const config = await loadConfig();
  const models = config.models ?? {};

  // Role-specific config (null means "use default")
  const roleConfig = models[agentName as keyof typeof models];
  if (roleConfig && roleConfig !== null) return roleConfig as AgentModelConfig;

  // Fall back to default
  return (models.default as AgentModelConfig) ?? DEFAULT_MODEL;
}

/**
 * Resolve the effective model for a spawn. Single source of truth shared by the
 * provider router and every backing runtime adapter (pi / Agent SDK / LangChain).
 *
 * Precedence (highest first): explicit `options.model` → `CASE_MODEL_OVERRIDE`
 * env → per-agent config (`getModelForAgent`). Provider defaults to "anthropic"
 * for the two override paths, matching the prior inline logic in pi-adapter.
 */
export async function resolveAgentModel(options: {
  agentName: string;
  model?: string;
  provider?: string;
}): Promise<AgentModelConfig> {
  const modelOverride = process.env.CASE_MODEL_OVERRIDE;
  if (options.model) return { provider: options.provider ?? 'anthropic', model: options.model };
  if (modelOverride) return { provider: options.provider ?? 'anthropic', model: modelOverride };
  return getModelForAgent(options.agentName);
}

/**
 * Routing classifier: does this model run on the Claude Agent SDK (Anthropic) or
 * the LangChain runtime (everything else)? True when the provider is Anthropic or
 * the model id looks like a Claude family member (covers configs that omit/alias
 * the provider field).
 */
export function isClaudeModel(m: { provider?: string; model?: string }): boolean {
  const provider = m.provider?.toLowerCase();
  if (provider === 'anthropic') return true;
  // OpenRouter fronts Claude too (`anthropic/claude-*`), but it bills per-token
  // via the OpenAI-compatible endpoint — route to LangChain, not the SDK, so the
  // model-id regex below can't misclassify it as a subscription Claude.
  if (provider === 'openrouter') return false;
  return /claude|opus|sonnet|haiku/i.test(m.model ?? '');
}

/**
 * Routing classifier: does this model run on the GitHub Copilot SDK runtime?
 * True only for the explicit `copilot` provider — Copilot fronts both GPT and
 * Claude model ids, so a model-name heuristic would collide with the other two
 * backends. Must be checked BEFORE {@link isClaudeModel}: a Copilot session
 * running `claude-*` would otherwise misroute to the Claude Agent SDK.
 */
export function isCopilotProvider(m: { provider?: string }): boolean {
  return m.provider?.toLowerCase() === 'copilot';
}

/**
 * Per-agent workspace policy. `mutable` agents may write/edit the working tree;
 * everyone else is read-only (Read + Bash exploration, no Write/Edit). Single
 * source of truth so all three runtimes expose identical tool surfaces per role.
 */
export function toolPolicyFor(agentName: string): WorkspacePolicy {
  return agentName === 'implementer' || agentName === 'retrospective' ? 'mutable' : 'read-only';
}
