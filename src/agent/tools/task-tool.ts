import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { createTask } from '../../entry/task-factory.js';
import type { TaskCreateRequest } from '../../types.js';

const taskParams = Type.Object({
  repo: Type.String({ description: 'Target repo name from projects.json' }),
  title: Type.String({ description: 'Task title' }),
  description: Type.String({ description: 'Task description' }),
  issue: Type.Optional(Type.String({ description: 'Issue identifier' })),
  issueType: Type.Optional(Type.Union([Type.Literal('github'), Type.Literal('linear'), Type.Literal('freeform')])),
});

export function createTaskTool(caseRoot: string): ToolDefinition<typeof taskParams> {
  return {
    name: 'create_task',
    label: 'Task',
    description: 'Create a new case task with JSON and markdown files',
    promptSnippet: 'Create a new task for a repo',
    parameters: taskParams,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const request: TaskCreateRequest = {
        repo: params.repo,
        title: params.title,
        description: params.description,
        issue: params.issue,
        issueType: params.issueType ?? 'freeform',
        trigger: { type: 'cli', user: 'local' },
      };

      const result = await createTask(caseRoot, request);

      return {
        content: [
          {
            type: 'text',
            text: `Task created: ${result.taskId}\n  JSON: ${result.taskJsonPath}\n  Spec: ${result.taskMdPath}`,
          },
        ],
        details: result,
      };
    },
  };
}
