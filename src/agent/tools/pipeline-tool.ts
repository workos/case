import { Type } from '@sinclair/typebox';
import type { ToolDefinition, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { runPipeline } from '../../pipeline.js';
import { buildPipelineConfig } from '../../config.js';

const pipelineParams = Type.Object({
  taskJsonPath: Type.String({ description: 'Path to the .task.json file' }),
  mode: Type.Optional(Type.String({ description: 'attended or unattended' })),
  dryRun: Type.Optional(Type.Boolean({ description: 'Skip agent spawning' })),
});

export function createPipelineTool(caseRoot: string): ToolDefinition<typeof pipelineParams> {
  return {
    name: 'run_pipeline',
    label: 'Pipeline',
    description: 'Run the case agent pipeline (implement → verify → review → close → retrospective) for a task',
    promptSnippet: 'Run the case pipeline for a task file',
    parameters: pipelineParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const config = await buildPipelineConfig({
        taskJsonPath: params.taskJsonPath,
        mode: (params.mode as 'attended' | 'unattended') ?? 'attended',
        dryRun: params.dryRun ?? false,
      });

      const start = Date.now();
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
  };
}
