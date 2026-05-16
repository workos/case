import type { SpawnAgentOptions, SpawnAgentResult } from '../types.js';

export type WorkspacePolicy = 'mutable' | 'read-only';

export interface CaseAgentRuntime {
  spawn(options: SpawnAgentOptions): Promise<SpawnAgentResult>;
  createTools(agentName: string, cwd: string, policy?: WorkspacePolicy): unknown[];
  abort(): void;
}
