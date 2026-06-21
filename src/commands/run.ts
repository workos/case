import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { buildPipelineConfig } from '../config.js';
import { runPipeline } from '../pipeline.js';
import { runCliOrchestrator } from '../entry/cli-orchestrator.js';
import { startOrchestratorSession } from '../agent/orchestrator-session.js';
import { createLogger } from '../util/logger.js';
import { resolvePackageRoot } from '../paths.js';
import type { PipelineMode } from '../types.js';

const log = createLogger();

export const description = 'Run the agent pipeline (default)';

/**
 * Handler for `case run` (also the default when no verb is supplied).
 *
 * Mirrors the original inline dispatch in src/index.ts before Phase 2 — kept
 * intact for back-compat with existing `ca` invocations. Parses its own argv
 * slice via `parseArgs` so the router stays verb-agnostic.
 */
export async function handler(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printRunHelp();
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string', short: 't' },
      'repo-path': { type: 'string' },
      mode: { type: 'string', short: 'm' },
      agent: { type: 'boolean' },
      model: { type: 'string' },
      'dry-run': { type: 'boolean' },
      fresh: { type: 'boolean' },
      tui: { type: 'boolean' },
    },
    allowPositionals: true,
    strict: false,
  });

  // --model flag: override model for all agents in this run
  if (values.model) {
    process.env.CASE_MODEL_OVERRIDE = values.model as string;
  }

  if (values.agent) {
    const argument = positionals[0];
    const caseRoot = resolvePackageRoot();

    try {
      await startOrchestratorSession({
        caseRoot,
        argument: argument || undefined,
        mode: 'attended',
      });
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('orchestrator session crashed', { error: msg });
      process.stderr.write(`Fatal: ${msg}\n`);
      return 1;
    }
  }

  if (values.task) {
    // Explicit --task flag: existing pipeline-only flow
    return runTaskFlow(values);
  }

  // Positional argument routing: number, Linear ID, or freeform text
  const argument = positionals[0];

  const mode = values.mode as PipelineMode | undefined;
  if (mode && mode !== 'attended' && mode !== 'unattended') {
    process.stderr.write('Error: --mode must be "attended" or "unattended"\n');
    return 1;
  }

  const caseRoot = resolvePackageRoot();

  // Suppress structured JSON logs for interactive CLI use
  process.env.CASE_QUIET = '1';

  try {
    await runCliOrchestrator({
      argument: argument || undefined,
      mode: mode ?? 'attended',
      dryRun: (values['dry-run'] as boolean) ?? false,
      fresh: (values.fresh as boolean) ?? false,
      caseRoot,
      renderer: values.tui ? 'tui' : undefined,
    });
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('cli orchestrator crashed', { error: msg });
    process.stderr.write(`Fatal: ${msg}\n`);
    return 1;
  }
}

function printRunHelp(): void {
  const text = `Usage: ca run [options] [issue]
       ca [issue]
       ca --agent [issue]

Run the agent pipeline for a GitHub or Linear issue.

Options:
  --task, -t <td-id>      Run an existing td task directly (by issue handle)
  --repo-path <path>      Repo whose td store holds --task (default: cwd)
  --agent                 Start an interactive steering session
  --model <model>         Override model for all agents in this run
  --mode, -m <mode>       "attended" (default) or "unattended"
  --dry-run               Validate without spawning agents
  --fresh                 Ignore existing task state and start clean
  --tui                   Launch full-screen TUI mode
  --help, -h              Show this help
`;
  process.stdout.write(text);
}

async function runTaskFlow(values: Record<string, unknown>): Promise<number> {
  // --task takes a td issue handle; --repo-path locates its `.todos/` store (default cwd).
  const tdId = values.task as string;
  const repoPath = resolve((values['repo-path'] as string | undefined) ?? '.');

  const mode = values.mode as PipelineMode | undefined;
  if (mode && mode !== 'attended' && mode !== 'unattended') {
    process.stderr.write('Error: --mode must be "attended" or "unattended"\n');
    return 1;
  }

  try {
    const config = await buildPipelineConfig({
      tdId,
      repoPath,
      mode,
      dryRun: values['dry-run'] as boolean | undefined,
    });

    if (values.tui) {
      config.renderer = 'tui';
    }

    await runPipeline(config);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('pipeline crashed', { error: msg });
    process.stderr.write(`Fatal: ${msg}\n`);
    return 1;
  }
}
