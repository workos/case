import { Type } from '@sinclair/typebox';
import { defineTool } from './define-tool.js';
import { runPipeline } from '../../pipeline.js';
import { buildPipelineConfig } from '../../config.js';

const pipelineParams = Type.Object({
  taskJsonPath: Type.String({ description: 'Path to the .task.json file' }),
  mode: Type.Optional(Type.String({ description: 'attended or unattended' })),
  dryRun: Type.Optional(Type.Boolean({ description: 'Skip agent spawning' })),
  approve: Type.Optional(Type.Boolean({ description: 'Enable human approval gate between review and close' })),
});

export function createPipelineTool(_caseRoot: string, defaults?: { approve?: boolean }) {
  return defineTool({
    name: 'run_pipeline',
    label: 'Pipeline',
    description: 'Run the case agent pipeline (implement → verify → review → close → retrospective) for a task',
    promptSnippet: 'Run the case pipeline for a task file',
    parameters: pipelineParams,
    execute: async (_toolCallId, params, _signal, onUpdate, _ctx) => {
      const config = await buildPipelineConfig({
        taskJsonPath: params.taskJsonPath,
        mode: (params.mode as 'attended' | 'unattended') ?? 'attended',
        dryRun: params.dryRun ?? false,
        approve: params.approve ?? defaults?.approve ?? false,
      });

      config.onAgentHeartbeat = (elapsedMs) => {
        onUpdate?.({
          content: [{ type: 'text', text: `... still running (${Math.floor(elapsedMs / 1000)}s)\n` }],
          details: { taskJsonPath: params.taskJsonPath },
        });
      };

      await runPipeline(config);

      return {
        content: [{ type: 'text', text: 'Pipeline completed successfully.' }],
        details: { taskJsonPath: params.taskJsonPath },
      };
    },
  });
}
