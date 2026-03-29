import { Type } from '@sinclair/typebox';
import { defineTool } from './define-tool.js';
import { executeFromIdeation } from '../from-ideation.js';
import { detectRepo } from '../../entry/repo-detector.js';

const fromIdeationParams = Type.Object({
  ideationFolder: Type.String({ description: 'Path to ideation folder containing contract.md and spec files' }),
  phase: Type.Optional(Type.Number({ description: 'Specific phase to execute (default: all)' })),
});

export function createFromIdeationTool(caseRoot: string) {
  return defineTool({
    name: 'run_from_ideation',
    label: 'From Ideation',
    description: 'Execute an ideation contract through the case pipeline — all phases on one branch, one PR',
    promptSnippet: 'Execute ideation specs through the pipeline',
    parameters: fromIdeationParams,
    execute: async (_toolCallId, params, _signal, onUpdate, _ctx) => {
      const detected = await detectRepo(caseRoot);

      const result = await executeFromIdeation({
        ideationFolder: params.ideationFolder,
        caseRoot,
        repoName: detected.name,
        repoPath: detected.path,
        phase: params.phase,
        onProgress: (message) => {
          onUpdate?.({
            content: [{ type: 'text', text: message }],
            details: { ideationFolder: params.ideationFolder },
          });
        },
      });

      const summary = result.success
        ? `Pipeline completed. PR: ${result.prUrl}\n\nPhases:\n${result.phases.map((p) => `  Phase ${p.phase}: ${p.status} — ${p.summary}`).join('\n')}`
        : `Pipeline failed: ${result.error}\n\nPhases:\n${result.phases.map((p) => `  Phase ${p.phase}: ${p.status}`).join('\n')}`;

      return {
        content: [{ type: 'text', text: summary }],
        details: result,
      };
    },
  });
}
