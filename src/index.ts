#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildPipelineConfig } from './config.js';
import { runPipeline } from './pipeline.js';
import { startServer } from './server.js';
import { createTask } from './entry/task-factory.js';
import { runCliOrchestrator } from './entry/cli-orchestrator.js';
import { startOrchestratorSession } from './agent/orchestrator-session.js';
import { createLogger } from './util/logger.js';
import type { PipelineMode, ServerConfig, TaskCreateRequest } from './types.js';

const log = createLogger();

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      task: { type: 'string', short: 't' },
      mode: { type: 'string', short: 'm' },
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      'webhook-secret': { type: 'string' },
      agent: { type: 'boolean' },
      model: { type: 'string' },
      'dry-run': { type: 'boolean' },
      approve: { type: 'boolean' },
      fresh: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      repo: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      issue: { type: 'string' },
      'issue-type': { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  // --model flag: override model for all agents in this run
  if (values.model) {
    process.env.CASE_MODEL_OVERRIDE = values.model as string;
  }

  const command = positionals[0] ?? 'run';

  if (values.agent) {
    const argument = command === 'run' ? positionals[1] : positionals[0];
    const caseRoot = resolveCaseRoot();

    try {
      await startOrchestratorSession({
        caseRoot,
        argument: argument || undefined,
        mode: 'attended',
        approve: values.approve as boolean | undefined,
      });
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('orchestrator session crashed', { error: msg });
      process.stderr.write(`Fatal: ${msg}\n`);
      process.exit(1);
    }
  } else if (command === 'create') {
    await runCreate(values);
  } else if (command === 'serve') {
    await runServe(values);
  } else if (values.task) {
    // Explicit --task flag: existing pipeline-only flow
    await runTask(values);
  } else {
    // Positional argument routing: number, Linear ID, or freeform text
    // `bun src/index.ts 1234` or `bun src/index.ts run 1234`
    const argument = command === 'run' ? positionals[1] : positionals[0];

    // argument may be undefined for re-entry via .case/active
    const mode = values.mode as PipelineMode | undefined;
    if (mode && mode !== 'attended' && mode !== 'unattended') {
      process.stderr.write('Error: --mode must be "attended" or "unattended"\n');
      process.exit(1);
    }

    const caseRoot = resolveCaseRoot();

    // Suppress structured JSON logs for interactive CLI use
    process.env.CASE_QUIET = '1';

    try {
      await runCliOrchestrator({
        argument: argument || undefined,
        mode: mode ?? 'attended',
        dryRun: (values['dry-run'] as boolean) ?? false,
        fresh: (values.fresh as boolean) ?? false,
        approve: (values.approve as boolean) ?? false,
        caseRoot,
      });
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('cli orchestrator crashed', { error: msg });
      process.stderr.write(`Fatal: ${msg}\n`);
      process.exit(1);
    }
  }
}

/**
 * Resolve the case root directory.
 * Uses CASE_ROOT env var if set, otherwise walks up from cwd looking for projects.json.
 */
function resolveCaseRoot(): string {
  if (process.env.CASE_ROOT) return resolve(process.env.CASE_ROOT);

  // Walk up from script location (src/index.ts -> project root)
  const scriptDir = import.meta.dir;
  const candidate = resolve(scriptDir, '..');
  return candidate;
}

async function runTask(values: Record<string, unknown>) {
  if (!values.task) {
    process.stderr.write('Error: --task <path> is required\n');
    printUsage();
    process.exit(1);
  }

  const taskPath = values.task as string;
  if (!(await Bun.file(taskPath).exists())) {
    process.stderr.write(`Error: task file not found: ${taskPath}\n`);
    process.exit(1);
  }

  const mode = values.mode as PipelineMode | undefined;
  if (mode && mode !== 'attended' && mode !== 'unattended') {
    process.stderr.write(`Error: --mode must be "attended" or "unattended"\n`);
    process.exit(1);
  }

  try {
    const config = await buildPipelineConfig({
      taskJsonPath: taskPath,
      mode,
      dryRun: values['dry-run'] as boolean | undefined,
      approve: values.approve as boolean | undefined,
    });

    await runPipeline(config);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('pipeline crashed', { error: msg });
    process.stderr.write(`Fatal: ${msg}\n`);
    process.exit(1);
  }
}

async function runCreate(values: Record<string, unknown>) {
  const repo = values.repo as string | undefined;
  const title = values.title as string | undefined;
  const description = values.description as string | undefined;

  if (!repo || !title || !description) {
    process.stderr.write('Error: --repo, --title, and --description are required\n');
    printUsage();
    process.exit(1);
  }

  const caseRoot = resolve(process.cwd());
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error creating task: ${msg}\n`);
    process.exit(1);
  }
}

async function runServe(values: Record<string, unknown>) {
  const caseRoot = resolve(process.cwd());
  const port = parseInt((values.port as string) ?? '3847', 10);
  const host = (values.host as string) ?? '127.0.0.1';
  const webhookSecret = (values['webhook-secret'] as string) ?? process.env.CASE_WEBHOOK_SECRET;

  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;

  const serverConfig: ServerConfig = {
    port,
    host,
    webhookSecret,
    scanners: {
      ci: {
        enabled: true,
        intervalMs: ONE_HOUR,
        repos: [], // all repos
        autoStart: false, // require human approval
      },
      staleDocs: {
        enabled: true,
        intervalMs: ONE_DAY,
        repos: [],
        autoStart: false,
      },
      deps: {
        enabled: true,
        intervalMs: 7 * ONE_DAY,
        repos: [],
        autoStart: false,
      },
    },
  };

  try {
    await startServer(caseRoot, serverConfig);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('server crashed', { error: msg });
    process.stderr.write(`Fatal: ${msg}\n`);
    process.exit(1);
  }
}

function printUsage() {
  process.stdout.write(`
Usage:
  bun src/index.ts [<issue>] [options]              Detect repo, fetch issue, run pipeline
  bun src/index.ts --agent [<issue>] [options]      Interactive orchestrator session
  bun src/index.ts [run] --task <path> [options]    Run pipeline for an existing task
  bun src/index.ts create [options]                 Create a new task
  bun src/index.ts serve [options]                  Start as HTTP service

Standalone CLI (run from a target repo):
  (no argument)               Resume active task via .case/active marker
  <issue>                     GitHub issue number (e.g., 1234)
                              Linear ID (e.g., DX-1234)
                              Freeform text (quoted, e.g., "fix login bug")

Agent options:
  --agent                   Start interactive orchestrator session (Pi TUI)
                            Without argument: freeform planning session
                            With issue: starts working on the issue immediately

Run options:
  --task, -t <path>         Path to .task.json file (skips Steps 0-3)
  --mode, -m <mode>         attended | unattended (default: attended)
  --model <id>              Override model for all agents (e.g., claude-opus-4-5)
  --dry-run                 Log phase transitions without spawning agents
  --approve                 Enable human approval gate between review and close
  --fresh                   Skip re-entry detection, create a new task from scratch

Create options:
  --repo <name>             Target repo from projects.json (required)
  --title <title>           Task title (required)
  --description <desc>      Task description (required)
  --issue <id>              Issue identifier (optional)
  --issue-type <type>       github | linear | freeform (default: freeform)
  --mode, -m <mode>         attended | unattended (default: attended)

Serve options:
  --port, -p <port>         HTTP port (default: 3847)
  --host <host>             Bind address (default: 127.0.0.1)
  --webhook-secret <secret> GitHub webhook secret (or CASE_WEBHOOK_SECRET env)

Common:
  --help, -h                Show this help
`);
}

main();
