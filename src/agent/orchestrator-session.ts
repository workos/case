import {
  createAgentSession,
  InteractiveMode,
  DefaultResourceLoader,
  SettingsManager,
  AuthStorage,
  ModelRegistry,
  getAgentDir,
} from '@mariozechner/pi-coding-agent';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { getModelForAgent } from './config.js';
import { detectRepo } from '../entry/repo-detector.js';
import { detectArgumentType, fetchIssue } from '../entry/issue-fetcher.js';
import { findTaskByIssue, findTaskByMarker } from '../entry/task-scanner.js';
import { createPipelineTool } from './tools/pipeline-tool.js';
import { createIssueTool } from './tools/issue-tool.js';
import { createTaskTool } from './tools/task-tool.js';
import { createBaselineTool } from './tools/baseline-tool.js';
import { createFromIdeationTool } from './tools/from-ideation-tool.js';

export interface OrchestratorSessionOptions {
  caseRoot: string;
  argument?: string;
  mode: 'attended';
}

export async function startOrchestratorSession(options: OrchestratorSessionOptions): Promise<void> {
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

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    appendSystemPrompt: buildOrchestratorSystemPrompt(options.caseRoot),
  });
  await resourceLoader.reload();

  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    model: model ?? undefined,
    resourceLoader,
    customTools: [
      createPipelineTool(options.caseRoot),
      createFromIdeationTool(options.caseRoot),
      createIssueTool(options.caseRoot),
      createTaskTool(options.caseRoot),
      createBaselineTool(options.caseRoot),
    ] as unknown as ToolDefinition[],
  });

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
        lines.push(`\nResume this task with run_pipeline, or discuss the approach.`);
      } else {
        try {
          const issue = await fetchIssue(argType, options.argument, detected.project.remote);
          lines.push(`\nIssue: ${issue.title}`);
          if (issue.body) lines.push(issue.body);
          lines.push(`\nReady to create a task and run the pipeline, or discuss first.`);
        } catch {
          lines.push(`\nIssue ${options.argument} — fetch failed, use fetch_issue tool to retry.`);
        }
      }
    } else {
      // No argument — check for active task via .case-active marker
      const match = await findTaskByMarker(options.caseRoot, detected.path);
      if (match) {
        lines.push(`\nActive task: ${match.taskJson.id} (status: ${match.taskJson.status})`);
        lines.push(`Entry phase: ${match.entryPhase}`);
        lines.push(`Task JSON: ${match.taskJsonPath}`);
        lines.push(`\nResume with run_pipeline, or discuss.`);
      } else {
        lines.push(`No active task. Ready for a new issue or discussion.`);
      }
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

function buildOrchestratorSystemPrompt(caseRoot: string): string {
  return `You are the Case orchestrator — an interactive agent for managing WorkOS OSS repos.

## Tools

- \`run_pipeline\` — Run the agent pipeline (implement → verify → review → close) for a task file.
- \`run_from_ideation\` — Execute an ideation contract through the pipeline. All phases on one branch, one PR.
- \`fetch_issue\` — Get context from GitHub or Linear.
- \`create_task\` — Set up task files for pipeline execution.
- \`run_baseline\` — Verify a repo meets conventions.

## Flows

### Quick flow
When the user says "go", "build this", or "let's do it" after discussing an idea:
1. Judge scope: small fix (1-3 files) → write a spec only. Multi-concern or architectural → write contract + specs.
2. Write artifacts to \`docs/ideation/{slug}/\` using the write tool.
3. Call \`run_from_ideation\` with the ideation folder path.

### Ideation flow
When the user wants to plan first ("let's think about...", "how should we..."):
1. Brainstorm and ask clarifying questions.
2. Write artifacts incrementally — contract.md first, then spec files.
3. Present for approval before executing.
4. Call \`run_from_ideation\` when approved.

### Issue flow
When the user provides an issue number or says "fix", "implement", "work on":
1. Fetch the issue with \`fetch_issue\`.
2. Create a task with \`create_task\`.
3. Run with \`run_pipeline\`.

### Pre-existing artifacts
When the user says "execute docs/ideation/foo/":
Call \`run_from_ideation\` directly with that path.

## Key context

- Case root: ${caseRoot}
- Projects manifest: ${caseRoot}/projects.json
- Golden principles: ${caseRoot}/docs/golden-principles.md
- Agent prompts: ${caseRoot}/agents/
- Convention: conventional commits, feature branches, PRs to main.

Use the \`read\` tool to view any of these files when you need details. Keep responses concise.`;
}
