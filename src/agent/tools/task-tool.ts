import { Type } from '@sinclair/typebox';
import { defineTool } from './define-tool.js';
import { createTask } from '../../entry/task-factory.js';
import type { TaskCreateRequest } from '../../types.js';

const taskParams = Type.Object({
  repo: Type.String({ description: 'Target repo name from projects.json' }),
  title: Type.String({ description: 'Task title' }),
  description: Type.String({ description: 'Task description' }),
  issue: Type.Optional(Type.String({ description: 'Issue identifier' })),
  issueType: Type.Optional(Type.Union([Type.Literal('github'), Type.Literal('linear'), Type.Literal('freeform')])),
  profile: Type.Optional(Type.Union([
    Type.Literal('tiny'),
    Type.Literal('standard'),
    Type.Literal('complex'),
  ], { description: 'Pipeline profile — tiny (docs/config), standard (bug fixes), complex (multi-file features)' })),
  verificationScenarios: Type.Optional(Type.String({ description: 'Markdown list of scenarios the verifier will test' })),
  nonGoals: Type.Optional(Type.String({ description: 'What is explicitly NOT in scope for this task' })),
  edgeCases: Type.Optional(Type.String({ description: 'Edge cases the implementer should consider' })),
  evidenceExpectations: Type.Optional(Type.String({ description: 'What evidence proves the fix works (screenshots, test output, etc.)' })),
});

export function createTaskTool(caseRoot: string) {
  return defineTool({
    name: 'create_task',
    label: 'Task',
    description: 'Create a new case task with JSON and markdown files',
    promptSnippet: 'Create a new task for a repo',
    parameters: taskParams,
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const request: TaskCreateRequest = {
        repo: params.repo,
        title: params.title,
        description: params.description,
        issue: params.issue,
        issueType: params.issueType ?? 'freeform',
        profile: params.profile,
        trigger: { type: 'cli', user: 'local' },
        verificationScenarios: params.verificationScenarios,
        nonGoals: params.nonGoals,
        edgeCases: params.edgeCases,
        evidenceExpectations: params.evidenceExpectations,
      };

      try {
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
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
          details: null,
        };
      }
    },
  });
}
