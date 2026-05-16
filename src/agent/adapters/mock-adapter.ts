import type { AgentName, SpawnAgentOptions, SpawnAgentResult } from '../../types.js';
import type { CaseAgentRuntime, WorkspacePolicy } from '../runtime.js';

export class MockRuntime implements CaseAgentRuntime {
  private responses: Map<string, SpawnAgentResult>;
  private _spawnCalls: SpawnAgentOptions[] = [];

  constructor(responses?: Record<string, SpawnAgentResult>) {
    this.responses = new Map(Object.entries(responses ?? {}));
  }

  async spawn(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
    this._spawnCalls.push(options);

    const response = this.responses.get(options.agentName);
    if (response) return response;

    return {
      raw: '',
      result: {
        status: 'completed',
        summary: `Mock ${options.agentName} completed`,
        artifacts: {
          commit: null,
          filesChanged: [],
          testsPassed: null,
          screenshotUrls: [],
          evidenceMarkers: [],
          prUrl: null,
          prNumber: null,
        },
        error: null,
      },
      durationMs: 0,
    };
  }

  createTools(_agentName: string, _cwd: string, _policy?: WorkspacePolicy): unknown[] {
    return [];
  }

  abort(): void {}

  get spawnCalls(): SpawnAgentOptions[] {
    return this._spawnCalls;
  }
}
