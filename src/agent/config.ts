import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AgentModelConfig } from '../types.js';

const CONFIG_PATH = resolve(homedir(), '.config/case/config.json');

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
    const raw = await Bun.file(CONFIG_PATH).text();
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
