import { Type } from '@sinclair/typebox';
import { defineTool } from './define-tool.js';
import { runBootstrap } from '../../commands/bootstrap.js';

const baselineParams = Type.Object({
  repoName: Type.String({ description: 'Repo name from projects.json to verify' }),
});

export function createBaselineTool(caseRoot: string) {
  return defineTool({
    name: 'run_baseline',
    label: 'Baseline',
    description: 'Verify a repo meets baseline conventions',
    promptSnippet: 'Run baseline checks on a repo',
    parameters: baselineParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const result = await runBootstrap(params.repoName, caseRoot);
      const failed = result.steps.find((step) => step.exitCode !== 0);

      return {
        content: [
          {
            type: 'text',
            text: result.ok ? `Baseline passed for ${params.repoName}.` : `Baseline failed:\n${failed?.output ?? ''}`,
          },
        ],
        details: { passed: result.ok, steps: result.steps },
      };
    },
  });
}
