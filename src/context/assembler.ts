import { resolve } from 'node:path';
import type { AgentName, AgentResult, PipelineConfig, TaskJson } from '../types.js';
import type { RepoContext } from './prefetch.js';

/**
 * Read an agent .md prompt template and build a role-specific prompt.
 *
 * Each role gets ONLY what it needs:
 * - Implementer: task paths + repo + issue + playbook + working memory + learnings + check fields
 * - Verifier: task paths + repo (deliberately minimal — fresh-context testing)
 * - Reviewer: task paths + repo (reviewer reads golden principles itself)
 * - Closer: task paths + repo + verifier AGENT_RESULT + reviewer AGENT_RESULT
 */
export async function assemblePrompt(
  role: AgentName,
  config: PipelineConfig,
  task: TaskJson,
  repoContext: RepoContext,
  previousResults: Map<AgentName, AgentResult>,
): Promise<string> {
  const templatePath = resolve(config.caseRoot, `agents/${role}.md`);
  const template = await Bun.file(templatePath).text();

  const contextBlock = buildContextBlock(role, config, task, repoContext, previousResults);

  return `${template}\n\n${contextBlock}`;
}

function buildContextBlock(
  role: AgentName,
  config: PipelineConfig,
  task: TaskJson,
  repoContext: RepoContext,
  previousResults: Map<AgentName, AgentResult>,
): string {
  const lines: string[] = ['## Task Context', ''];

  // Common context for all roles
  lines.push(`- **Task file**: \`${config.taskMdPath}\``);
  lines.push(`- **Task JSON**: \`${config.taskJsonPath}\``);
  lines.push(`- **Target repo**: \`${config.repoPath}\``);
  lines.push(`- **Repo name**: ${config.repoName}`);
  lines.push('');

  switch (role) {
    case 'implementer':
      appendImplementerContext(lines, config, task, repoContext);
      break;

    case 'verifier':
      // Deliberately minimal — fresh-context testing
      break;

    case 'reviewer':
      // Reviewer reads golden principles itself — minimal context
      break;

    case 'closer':
      appendCloserContext(lines, previousResults);
      break;

    case 'orchestrator':
      // Orchestrator doesn't get spawned by the pipeline
      break;
  }

  return lines.join('\n');
}

function appendImplementerContext(
  lines: string[],
  config: PipelineConfig,
  task: TaskJson,
  repoContext: RepoContext,
): void {
  if (task.issue) {
    lines.push(`- **Issue**: ${task.issueType ?? 'unknown'} ${task.issue}`);
  }

  // Working memory for retry/resume context
  if (repoContext.workingMemory) {
    lines.push('');
    lines.push('### Working Memory (from previous run)');
    lines.push('');
    lines.push(repoContext.workingMemory);
  }

  // Learnings from previous tasks in this repo
  if (repoContext.learnings) {
    lines.push('');
    lines.push('### Repo Learnings');
    lines.push('');
    lines.push(repoContext.learnings);
  }

  // Check command fields
  if (task.checkCommand) {
    lines.push('');
    lines.push(`- **Check command**: \`${task.checkCommand}\``);
    if (task.checkBaseline !== null && task.checkBaseline !== undefined) {
      lines.push(`- **Check baseline**: ${task.checkBaseline}`);
    }
    if (task.checkTarget !== null && task.checkTarget !== undefined) {
      lines.push(`- **Check target**: ${task.checkTarget}`);
    }
  }

  if (task.fastTestCommand) {
    lines.push(`- **Fast test command**: \`${task.fastTestCommand}\``);
  }
}

function appendCloserContext(lines: string[], previousResults: Map<AgentName, AgentResult>): void {
  const verifierResult = previousResults.get('verifier');
  const reviewerResult = previousResults.get('reviewer');

  if (verifierResult) {
    lines.push('### Verifier AGENT_RESULT');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(verifierResult, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (reviewerResult) {
    lines.push('### Reviewer AGENT_RESULT');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(reviewerResult, null, 2));
    lines.push('```');
    lines.push('');
  }
}
