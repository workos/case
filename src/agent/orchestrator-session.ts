import {
  createAgentSession,
  createAgentSessionRuntime,
  InteractiveMode,
  DefaultResourceLoader,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  getAgentDir,
  SessionManager,
} from '@mariozechner/pi-coding-agent';
import type { ExtensionAPI, ToolDefinition, CreateAgentSessionRuntimeResult } from '@mariozechner/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import { basename } from 'node:path';
import { mkdirSync, symlinkSync, existsSync } from 'node:fs';
import { getModelForAgent } from './config.js';
import { detectRepo } from '../entry/repo-detector.js';
import { detectArgumentType, fetchIssue } from '../entry/issue-fetcher.js';
import { findTaskByIssue } from '../entry/task-scanner.js';
import { createPipelineTool } from './tools/pipeline-tool.js';
import { createIssueTool } from './tools/issue-tool.js';
import { createTaskTool } from './tools/task-tool.js';
import { createBaselineTool } from './tools/baseline-tool.js';
import { isEmbeddedPackageRoot } from '../paths.js';

export interface OrchestratorSessionOptions {
  caseRoot: string;
  argument?: string;
  mode: 'attended';
}

export async function startOrchestratorSession(options: OrchestratorSessionOptions): Promise<void> {
  // Suppress structured JSON logs in interactive mode — the TUI provides its own feedback.
  // Preserve logging if CASE_DEBUG is explicitly set.
  if (!process.env.CASE_DEBUG) {
    process.env.CASE_QUIET = '1';
  }

  // Run pi fully isolated — no global settings, extensions, packages,
  // statusline, or theme from the user's ~/.pi/agent config.
  const realAgentDir = getAgentDir();
  const isolatedAgentDir = `${process.env.TMPDIR ?? '/tmp'}/case-orchestrator-pi-${process.pid}`;
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  process.env.PI_SKIP_VERSION_CHECK = '1';

  mkdirSync(isolatedAgentDir, { recursive: true });
  const realAuth = `${realAgentDir}/auth.json`;
  const isolatedAuth = `${isolatedAgentDir}/auth.json`;
  if (existsSync(realAuth) && !existsSync(isolatedAuth)) {
    symlinkSync(realAuth, isolatedAuth);
  }

  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

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
  const sessionManager = SessionManager.create(cwd);

  const caseRoot = options.caseRoot;
  const systemPrompt = buildOrchestratorSystemPrompt(caseRoot);

  const runtimeFactory = async (factoryOpts: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
  }): Promise<CreateAgentSessionRuntimeResult> => {
    const sm = SettingsManager.create(factoryOpts.cwd, factoryOpts.agentDir);
    sm.setQuietStartup(true);

    const rl = new DefaultResourceLoader({
      cwd: factoryOpts.cwd,
      agentDir: factoryOpts.agentDir,
      settingsManager: sm,
      appendSystemPrompt: [systemPrompt],
      extensionFactories: [minimalStatusline(factoryOpts.cwd)],
    });
    await rl.reload();

    const result = await createAgentSession({
      cwd: factoryOpts.cwd,
      agentDir: factoryOpts.agentDir,
      authStorage,
      modelRegistry,
      model: model ?? undefined,
      resourceLoader: rl,
      sessionManager: factoryOpts.sessionManager,
      customTools: [
        createPipelineTool(caseRoot),
        createIssueTool(caseRoot),
        createTaskTool(caseRoot),
        createBaselineTool(caseRoot),
      ] as unknown as ToolDefinition[],
    });

    return {
      ...result,
      services: { settingsManager: sm, resourceLoader: rl } as any,
      diagnostics: [],
    };
  };

  const runtime = await createAgentSessionRuntime(runtimeFactory, {
    cwd,
    agentDir,
    sessionManager,
  });

  if (process.env.CASE_DEBUG) {
    for (const diag of runtime.diagnostics) {
      process.stderr.write(`⚠ ${diag.message}\n`);
    }
  }

  const interactive = new InteractiveMode(runtime, {
    modelFallbackMessage: runtime.modelFallbackMessage,
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
      const match = await findTaskByIssue(options.caseRoot, detected.name, argType, options.argument, detected.path);

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

              const barColor: 'error' | 'warning' | 'success' = pct >= 80 ? 'error' : pct >= 60 ? 'warning' : 'success';
              const bar = theme.fg(barColor, '█'.repeat(filled)) + theme.fg('dim', '░'.repeat(empty));
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

            const pad = ' '.repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(barStr)));
            return [truncateToWidth(left + pad + barStr, width)];
          },
        };
      });
    });
  };
}

function buildOrchestratorSystemPrompt(caseRoot: string): string {
  const packageAssetLines = isEmbeddedPackageRoot(caseRoot)
    ? [
        '- Package assets: embedded in the current `ca` binary',
        '- Projects manifest: read from the configured user config path',
        '- Golden principles and agent prompts: injected by the pipeline when needed',
      ]
    : [
        `- Case root: ${caseRoot}`,
        `- Projects manifest: ~/.config/case/projects.json (or ca onboard to add repos)`,
        `- Golden principles: ${caseRoot}/docs/golden-principles.md`,
        `- Agent prompts: ${caseRoot}/agents/`,
      ];

  return `You are the Case orchestrator — an interactive agent for managing target repos.

**Always wait for the user's first message before calling any tools.** The initial context below is background information, not a request to act. Greet the user briefly and wait.

## Critical Rule: Never Implement Directly

**You are a planner and dispatcher, not an implementer.** You must NEVER directly modify files in the target repo — no editing code, no running \`pnpm add\`, no \`rm\`, no \`git commit\`. Your job is to:
1. Understand what the user wants (explore, read, ask questions)
2. Create or refine a case task with clear acceptance criteria
3. Dispatch to the pipeline tools which spawn dedicated agents to do the work

If you catch yourself about to edit a source file or run a command that changes repo state — stop. That work belongs to the implementer agent, not you.

**Reading and exploring is always fine.** Read files, run \`git log\`, check configs, run \`--help\` commands — anything read-only to understand the problem.

## Tools

- \`run_pipeline\` — Run the agent pipeline (implement → verify → review → close) for a task file.
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
Translate the request into a task: title, description, target repo, acceptance criteria, verification scenarios, non-goals, edge cases, and evidence expectations. The task should be small enough for one PR.

**Evidence expectations are required.** Every task must specify what proof the verifier should produce. Use the repo's \`evidenceStrategy\` from projects.json to guide what kind of evidence to expect:

| Strategy | When | Evidence expectations should specify |
|---|---|---|
| \`ui-screenshot\` | App with a web UI | Before/after screenshots showing the behavior change. What page to visit, what to click, what should look different. |
| \`scenario-script\` | Library or CLI | A consumer-perspective script that imports the changed API, exercises the specific code path, and asserts expected behavior. Describe what the script should test and what PASS looks like. |
| \`test-output\` | Pure logic, config, or docs | Full test suite passes, typecheck passes, build succeeds. Name specific new or modified tests that cover the change. |

Write evidence expectations as concrete, falsifiable statements — not vague "verify it works" descriptions. The verifier uses these to decide what to test and the closer uses them to decide what to include in the PR.

**Bad:** "Verify the fix works"
**Good (ui-screenshot):** "Before: /settings page shows 'undefined' for org name. After: /settings page shows the actual org name. Requires AuthKit login with test credentials."
**Good (scenario-script):** "Script imports \`listOrganizations\` from the SDK, calls it with \`limit: 1\`, asserts the response has a \`data\` array with at least one entry."
**Good (test-output):** "The new \`serializeSession()\` unit tests pass. Typecheck passes. No regressions in existing session tests."

### 3. Confirm
Present a brief summary of what will be built and ask the user to confirm before executing. Keep it to 3-5 bullet points.

### 4. Execute
Call \`create_task\`, then \`run_pipeline\` with the created task JSON path. The pipeline handles implementation, verification, review, PR creation, and retrospective learning.

## Flows

### Freeform request ("convert to oxfmt", "add dark mode", "fix the login bug")
1. **Understand**: Read the relevant code and configs. Ask clarifying questions only if needed.
2. **Plan**: Draft the task fields and evidence expectations.
3. **Confirm**: "Here's the plan: ... Ready to execute?"
4. **Execute**: Call \`create_task\`, then \`run_pipeline\`.

### Issue reference ("#42", "DX-1234")
1. Fetch the issue with \`fetch_issue\`.
2. Create a task with \`create_task\`.
3. Run with \`run_pipeline\`.

## Key context

${packageAssetLines.join('\n')}
- Convention: conventional commits, feature branches, PRs to main.
- Working memory: agents persist progress to \`.case/<task-slug>/working-memory.json\` via \`ca update-memory\`. The pipeline reads it between phases to inject prior context — you don't need to manage it manually, but you can inspect it if a run is misbehaving.

Use the \`read\` tool for on-disk files when paths are available. Keep responses concise.`;
}
