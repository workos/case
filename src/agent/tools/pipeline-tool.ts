import { Type } from '@sinclair/typebox';
import { defineTool } from './define-tool.js';
import { runPipeline } from '../../pipeline.js';
import { buildPipelineConfig } from '../../config.js';

const pipelineParams = Type.Object({
  tdId: Type.String({ description: 'td issue handle for the task (e.g. td-a1b2c3)' }),
  repoPath: Type.String({ description: 'Target repo path whose td store holds the task' }),
  mode: Type.Optional(Type.String({ description: 'attended or unattended' })),
  dryRun: Type.Optional(Type.Boolean({ description: 'Skip agent spawning' })),
});

export function createPipelineTool(_caseRoot: string) {
  return defineTool({
    name: 'run_pipeline',
    label: 'Pipeline',
    description: 'Run the case agent pipeline (implement → verify → review → close → retrospective) for a task',
    promptSnippet: 'Run the case pipeline for a task file',
    parameters: pipelineParams,
    execute: async (_toolCallId, params, _signal, onUpdate, _ctx) => {
      const config = await buildPipelineConfig({
        tdId: params.tdId,
        repoPath: params.repoPath,
        mode: (params.mode as 'attended' | 'unattended') ?? 'attended',
        dryRun: params.dryRun ?? false,
      });

      config.onAgentHeartbeat = (elapsedMs) => {
        onUpdate?.({
          content: [{ type: 'text', text: `... still running (${Math.floor(elapsedMs / 1000)}s)\n` }],
          details: { tdId: params.tdId },
        });
      };

      await runPipeline(config);

      return {
        content: [{ type: 'text', text: 'Pipeline completed successfully.' }],
        details: { tdId: params.tdId },
      };
    },
  });
}
