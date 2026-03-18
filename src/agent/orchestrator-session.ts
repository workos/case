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
import { createPipelineTool } from './tools/pipeline-tool.js';
import { createIssueTool } from './tools/issue-tool.js';
import { createTaskTool } from './tools/task-tool.js';
import { createBaselineTool } from './tools/baseline-tool.js';

export interface OrchestratorSessionOptions {
  caseRoot: string;
  argument?: string;
  mode: 'attended';
}

export async function startOrchestratorSession(options: OrchestratorSessionOptions): Promise<void> {
  const cwd = process.cwd();
  const agentDir = getAgentDir();

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
    authStorage: AuthStorage.create(),
    modelRegistry: new ModelRegistry(AuthStorage.create()),
    resourceLoader,
    customTools: [
      createPipelineTool(options.caseRoot),
      createIssueTool(options.caseRoot),
      createTaskTool(options.caseRoot),
      createBaselineTool(options.caseRoot),
    ] as unknown as ToolDefinition[],
  });

  const interactive = new InteractiveMode(session, {
    modelFallbackMessage,
    initialMessage: options.argument ? `Work on issue: ${options.argument}` : undefined,
  });
  await interactive.run();
}

function buildOrchestratorSystemPrompt(caseRoot: string): string {
  return `You are the Case orchestrator — an interactive agent for managing WorkOS OSS repos.

## What you can do

- **Discuss & plan**: Talk through approaches, review code, answer questions about the codebase.
- **Run the pipeline**: Use \`run_pipeline\` to execute the full agent pipeline (implement → verify → review → close) for a task file.
- **Fetch issues**: Use \`fetch_issue\` to get context from GitHub or Linear.
- **Create tasks**: Use \`create_task\` to set up task files for pipeline execution.
- **Check baselines**: Use \`run_baseline\` to verify a repo meets conventions.

## When to run the pipeline vs discuss

- If the user provides an issue number or asks to "fix", "implement", or "work on" something → fetch the issue, create a task, run the pipeline.
- If the user asks "how should we approach this?" or "what do you think about..." → discuss first.
- If the user says "run it" or "go" → run the pipeline.

## Key context

- Case root: ${caseRoot}
- Projects manifest: ${caseRoot}/projects.json
- Golden principles: ${caseRoot}/docs/golden-principles.md
- Agent prompts: ${caseRoot}/agents/
- Convention: conventional commits, feature branches, PRs to main.

Use the \`read\` tool to view any of these files when you need details. Keep responses concise.`;
}
