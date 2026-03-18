import { resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { runScript } from '../../util/run-script.js';

const baselineParams = Type.Object({
  repoName: Type.String({ description: 'Repo name from projects.json to run bootstrap.sh against' }),
});

export function createBaselineTool(caseRoot: string): ToolDefinition<typeof baselineParams> {
  return {
    name: 'run_baseline',
    label: 'Baseline',
    description: 'Run bootstrap.sh to verify a repo meets baseline conventions',
    promptSnippet: 'Run baseline checks on a repo',
    parameters: baselineParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const bootstrapScript = resolve(caseRoot, 'scripts/bootstrap.sh');
      const result = await runScript('bash', [bootstrapScript, params.repoName], {
        cwd: caseRoot,
        timeout: 120_000,
      });

      const passed = result.exitCode === 0;
      const output = `${result.stdout}${result.stderr}`.trim();

      return {
        content: [
          {
            type: 'text',
            text: passed ? `Baseline passed for ${params.repoName}.` : `Baseline failed:\n${output}`,
          },
        ],
        details: { passed, exitCode: result.exitCode },
      };
    },
  };
}
