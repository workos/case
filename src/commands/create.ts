import { parseArgs } from 'node:util';
import { createTask } from '../entry/task-factory.js';
import { resolvePackageRoot } from '../paths.js';
import type { PipelineMode, TaskCreateRequest } from '../types.js';

export const description = 'Scaffold a new task file';

export async function handler(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      issue: { type: 'string' },
      'issue-type': { type: 'string' },
      mode: { type: 'string', short: 'm' },
    },
    allowPositionals: true,
    strict: false,
  });

  const repo = values.repo as string | undefined;
  const title = values.title as string | undefined;
  const description = values.description as string | undefined;

  if (!repo || !title || !description) {
    process.stderr.write('Error: --repo, --title, and --description are required\n');
    return 1;
  }

  const caseRoot = resolvePackageRoot();
  const mode = (values.mode as PipelineMode | undefined) ?? 'attended';
  const issueType = values['issue-type'] as 'github' | 'linear' | 'freeform' | undefined;

  const request: TaskCreateRequest = {
    repo,
    title,
    description,
    issue: values.issue as string | undefined,
    issueType: issueType ?? (values.issue ? 'github' : 'freeform'),
    mode,
    trigger: { type: 'cli', user: 'local' },
  };

  try {
    const result = await createTask(caseRoot, request);
    process.stdout.write(`Task created: ${result.taskId}\n`);
    process.stdout.write(`  JSON: ${result.taskJsonPath}\n`);
    process.stdout.write(`  Spec: ${result.taskMdPath}\n`);
    process.stdout.write(`\nRun with:\n  bun src/index.ts --task ${result.taskJsonPath}\n`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error creating task: ${msg}\n`);
    return 1;
  }
}
