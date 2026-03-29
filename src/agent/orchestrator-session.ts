import {
  createAgentSession,
  InteractiveMode,
  DefaultResourceLoader,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  getAgentDir,
} from '@mariozechner/pi-coding-agent';
import type { ExtensionAPI, ToolDefinition } from '@mariozechner/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import { basename, resolve } from 'node:path';
import { getModelForAgent } from './config.js';
import { detectRepo } from '../entry/repo-detector.js';
import { detectArgumentType, fetchIssue } from '../entry/issue-fetcher.js';
import { findTaskByIssue } from '../entry/task-scanner.js';
import { createPipelineTool } from './tools/pipeline-tool.js';
import { createIssueTool } from './tools/issue-tool.js';
import { createTaskTool } from './tools/task-tool.js';
import { createBaselineTool } from './tools/baseline-tool.js';
import { createFromIdeationTool } from './tools/from-ideation-tool.js';

export interface OrchestratorSessionOptions {
  caseRoot: string;
  argument?: string;
  mode: 'attended';
  /** Enable human approval gate between review and close. */
  approve?: boolean;
}

export async function startOrchestratorSession(options: OrchestratorSessionOptions): Promise<void> {
  // Suppress structured JSON logs in interactive mode — the TUI provides its own feedback.
  // Preserve logging if CASE_DEBUG is explicitly set.
  if (!process.env.CASE_DEBUG) {
    process.env.CASE_QUIET = '1';
  }

  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  // Resolve model: CLI override (env var) > config file > Pi defaults
  const modelOverride = process.env.CASE_MODEL_OVERRIDE;
  const modelConfig = modelOverride
    ? { provider: 'anthropic', model: modelOverride }
    : await getModelForAgent('orchestrator');
  const model = modelRegistry.find(modelConfig.provider, modelConfig.model);

  // Gather context before creating the session (same as cli-orchestrator Steps 0-0b)
  const contextBriefing = await gatherContext(options);

  printBanner(contextBriefing);

  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setQuietStartup(true);


  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: buildOrchestratorSystemPrompt(options.caseRoot),
    extensionFactories: [minimalStatusline(cwd)],
  });
  await resourceLoader.reload();

  const { session, extensionsResult, modelFallbackMessage } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model: model ?? undefined,
    resourceLoader,
    customTools: [
      createPipelineTool(options.caseRoot, { approve: options.approve }),
      createFromIdeationTool(options.caseRoot, { approve: options.approve }),
      createIssueTool(options.caseRoot),
      createTaskTool(options.caseRoot),
      createBaselineTool(options.caseRoot),
    ] as unknown as ToolDefinition[],
  });

  if (process.env.CASE_DEBUG && extensionsResult?.errors?.length) {
    for (const err of extensionsResult.errors) {
      process.stderr.write(`⚠ Extension error: ${err.path}\n  ${err.error}\n`);
    }
  }

  const interactive = new InteractiveMode(session, {
    modelFallbackMessage,
    initialMessage: contextBriefing,
  });
  await interactive.run();
}

async function gatherContext(options: OrchestratorSessionOptions): Promise<string> {
  const lines: string[] = [];

  try {
    const detected = await detectRepo(options.caseRoot);
    lines.push(`Repo: ${detected.name} (${detected.path})`);

    if (options.argument) {
      // User provided an issue — check for existing task, then fetch issue
      const argType = detectArgumentType(options.argument);
      const match = await findTaskByIssue(options.caseRoot, detected.name, argType, options.argument);

      if (match) {
        lines.push(`\nExisting task found: ${match.taskJson.id} (status: ${match.taskJson.status})`);
        lines.push(`Entry phase: ${match.entryPhase}`);
        lines.push(`Task JSON: ${match.taskJsonPath}`);
        if (match.taskJson.prUrl) lines.push(`PR: ${match.taskJson.prUrl}`);
        lines.push(`\nTask is resumable from the ${match.entryPhase} phase.`);
      } else {
        try {
          const issue = await fetchIssue(argType, options.argument, detected.project.remote);
          lines.push(`\nIssue: ${issue.title}`);
          if (issue.body) lines.push(issue.body);
          lines.push(`\nNo existing task for this issue.`);
        } catch {
          lines.push(`\nIssue ${options.argument} — fetch failed, use fetch_issue tool to retry.`);
        }
      }
    } else {
      // No argument — don't auto-detect active tasks.
      // Let the agent discover them on demand to avoid auto-execution.
      lines.push(`No argument provided.`);
      lines.push(`What would you like to work on?`);
    }
  } catch {
    // Not in a target repo — still useful for freeform sessions
    if (options.argument) {
      lines.push(`Work on issue: ${options.argument}`);
      lines.push(`(Not in a recognized target repo — cd to one for repo-aware features)`);
    }
  }

  return lines.join('\n');
}

function printBanner(contextBriefing: string): void {
  const W = 52;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const pad = (s: string) => s.slice(0, W).padEnd(W);
  const row = (content: string) => dim('  │') + content + dim('│');
  const hr = (l: string, r: string) => dim(`  ${l}${'─'.repeat(W)}${r}`);

  const home = process.env.HOME ?? '';
  const robot = ['   ▄█████▄', '   █ ● ○ █', '   █▄░░░▄█', '   ▀██ ██▀'];
  const info = contextBriefing
    .split('\n')
    .filter(Boolean)
    .map((line) => (home ? line.replaceAll(home, '~') : line));

  const lines = [
    '',
    hr('╭', '╮'),
    row(cyan(pad(robot[0]))),
    row(cyan(robot[1]) + bold('  case') + dim(' · agent orchestrator'.padEnd(W - 16))),
    row(cyan(pad(robot[2]))),
    row(cyan(pad(robot[3]))),
    hr('├', '┤'),
    ...info.map((line) => row(pad(`  ${line}`))),
    hr('╰', '╯'),
    '',
  ];

  process.stderr.write(lines.join('\n') + '\n');
}

/**
 * Minimal statusline for the case orchestrator.
 * Shows: project · branch · model · context bar + percentage
 * Loaded as an extensionFactory so it fires last and overrides any global statusline.
 */
function minimalStatusline(cwd: string) {
  return (pi: ExtensionAPI) => {
    pi.on('session_start', async (_event, ctx) => {
      ctx.ui.setFooter((tui, theme, footerData) => {
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose: unsub,
          invalidate() {},
          render(width: number): string[] {
            const sep = theme.fg('dim', ' · ');

            // Project name from cwd
            const project = theme.fg('accent', basename(cwd));

            // Git branch
            const branch = footerData.getGitBranch();
            const branchStr = branch ? theme.fg('muted', branch) : '';

            // Model
            const modelId = ctx.model?.id ?? '—';
            const modelStr = theme.fg('muted', modelId);

            // Context usage bar
            const usage = ctx.getContextUsage();
            const contextWindow = ctx.model?.contextWindow ?? 0;
            let barStr = '';

            if (usage?.tokens != null && contextWindow > 0) {
              const pct = Math.min(100, Math.round((usage.tokens / contextWindow) * 100));
              const barWidth = 10;
              const filled = Math.round((pct / 100) * barWidth);
              const empty = barWidth - filled;

              const barColor: 'error' | 'warning' | 'success' =
                pct >= 80 ? 'error' : pct >= 60 ? 'warning' : 'success';
              const bar =
                theme.fg(barColor, '█'.repeat(filled)) + theme.fg('dim', '░'.repeat(empty));
              barStr = bar + ' ' + theme.fg('dim', `${pct}%`);
            }

            // Assemble: project · branch · model
            const parts = [project];
            if (branchStr) parts.push(branchStr);
            parts.push(modelStr);

            const left = parts.join(sep);

            if (!barStr) {
              return [truncateToWidth(left, width)];
            }

            const pad = ' '.repeat(
              Math.max(1, width - visibleWidth(left) - visibleWidth(barStr)),
            );
            return [truncateToWidth(left + pad + barStr, width)];
          },
        };
      });
    });
  };
}

function buildOrchestratorSystemPrompt(caseRoot: string): string {
  return `You are the Case orchestrator — an interactive agent for managing WorkOS OSS repos.

**Always wait for the user's first message before calling any tools.** The initial context below is background information, not a request to act. Greet the user briefly and wait.

## Critical Rule: Never Implement Directly

**You are a planner and dispatcher, not an implementer.** You must NEVER directly modify files in the target repo — no editing code, no running \`pnpm add\`, no \`rm\`, no \`git commit\`. Your job is to:
1. Understand what the user wants (explore, read, ask questions)
2. Write ideation artifacts (contract.md, spec files) that describe the work
3. Dispatch to the pipeline tools which spawn dedicated agents to do the work

If you catch yourself about to edit a source file or run a command that changes repo state — stop. That work belongs to the implementer agent, not you.

**Reading and exploring is always fine.** Read files, run \`git log\`, check configs, run \`--help\` commands — anything read-only to understand the problem.

## Tools

- \`run_pipeline\` — Run the agent pipeline (implement → verify → review → [approve] → close) for a task file.
- \`run_from_ideation\` — Execute an ideation contract through the pipeline. All phases on one branch, one PR. Inherits \`--approve\` from CLI flags.
- \`fetch_issue\` — Get context from GitHub or Linear.
- \`create_task\` — Set up task files for pipeline execution.
- \`run_baseline\` — Verify a repo meets conventions.

## Your Workflow

Every request follows this pattern: **Understand → Plan → Confirm → Execute**

### 1. Understand
Explore the codebase to understand the current state. Read relevant files, check configs, understand the scope. Ask the user clarifying questions if the request is ambiguous or has multiple valid approaches.

**Ask before assuming** when:
- The request could mean different things
- There are trade-offs the user should weigh
- You need domain context you don't have

**Don't ask** when:
- The request is clear and well-scoped
- The approach is obvious from the codebase
- You have enough context to write a good spec

### 2. Plan
Write ideation artifacts to \`docs/ideation/{slug}/\` in the target repo:
- **contract.md** — Problem, goals, success criteria, scope
- **spec.md** (or **spec-phase-N.md**) — Implementation details, file changes, validation commands

For simple tasks (1-3 files, mechanical changes): a spec.md alone is sufficient.
For complex tasks: write a full contract + specs.

### 3. Confirm
Present a brief summary of what will be built and ask the user to confirm before executing. Keep it to 3-5 bullet points.

### 4. Execute
Call \`run_from_ideation\` with the ideation folder path. The pipeline handles implementation, verification, review, and PR creation.

## Flows

### Freeform request ("convert to oxfmt", "add dark mode", "fix the login bug")
1. **Understand**: Read the relevant code and configs. Ask clarifying questions only if needed.
2. **Plan**: Write ideation artifacts describing the change.
3. **Confirm**: "Here's the plan: ... Ready to execute?"
4. **Execute**: Call \`run_from_ideation\`.

### Issue reference ("#42", "DX-1234")
1. Fetch the issue with \`fetch_issue\`.
2. Create a task with \`create_task\`.
3. Run with \`run_pipeline\`.

### Pre-existing artifacts ("execute docs/ideation/foo/")
Call \`run_from_ideation\` directly.

## Key context

- Case root: ${caseRoot}
- Projects manifest: ${caseRoot}/projects.json
- Golden principles: ${caseRoot}/docs/golden-principles.md
- Agent prompts: ${caseRoot}/agents/
- Convention: conventional commits, feature branches, PRs to main.

Use the \`read\` tool to view any of these files when you need details. Keep responses concise.`;
}
