import type { AgentName, AgentResult, PipelineConfig, RevisionRequest, TaskJson } from '../types.js';
import type { RepoContext } from './prefetch.js';
import { readPackageAssetSync } from '../package-assets.js';

/**
 * Read an agent .md prompt template and build a role-specific prompt.
 *
 * Each role gets ONLY what it needs:
 * - Implementer: task paths + repo + issue + playbook + working memory + learnings + check fields
 * - Verifier: task paths + repo + project commands (fresh-context testing)
 * - Reviewer: task paths + repo + golden principles
 * - Closer: task paths + repo + verifier AGENT_RESULT + reviewer AGENT_RESULT
 */
export async function assemblePrompt(
  role: AgentName,
  config: PipelineConfig,
  task: TaskJson,
  repoContext: RepoContext,
  previousResults: Map<AgentName, AgentResult>,
  revision?: RevisionRequest,
): Promise<string> {
  const rawTemplate = readPackageAssetSync(`agents/${role}.md`, { packageRoot: config.packageRoot });
  const substituted = substitutePathVars(rawTemplate, config);
  const template = inlineDocs(substituted, config.packageRoot);

  const contextBlock = buildContextBlock(role, config, task, repoContext, previousResults);

  let prompt = `${template}\n\n${contextBlock}`;

  // Prepend revision context for implementer re-entry
  if (role === 'implementer' && revision) {
    prompt = buildRevisionContext(revision) + '\n\n' + prompt;
  }

  return prompt;
}

/**
 * Replace `{{packageRoot}}`, `{{dataDir}}`, and selected project metadata tokens in agent prompts.
 *
 * Unknown `{{...}}` tokens pass through unchanged — only whitelisted variable names
 * are substituted, so prompt content that happens to contain double braces is preserved.
 */
function substitutePathVars(content: string, config: PipelineConfig): string {
  return content
    .replace(/\{\{packageRoot\}\}/g, config.packageRoot)
    .replace(/\{\{dataDir\}\}/g, config.dataDir)
    .replace(/\{\{repoType\}\}/g, config.project?.type ?? 'app');
}

const INJECT_MARKER = /<!--\s*inject:\s*(\S+)\s*-->/g;

/**
 * Resolve `<!-- inject: docs/path.md -->` markers by inlining the referenced
 * package asset's content. Single-pass — inlined content is
 * NOT re-scanned for nested markers, preventing recursive loops.
 *
 * Size limit (default 8KB, tunable via `CASE_INLINE_MAX_BYTES`): oversized files
 * are truncated and footed with `[truncated]`. Missing files leave the marker
 * verbatim and log a warning to stderr. Empty paths (`<!-- inject: -->`) are
 * left verbatim.
 */
function inlineDocs(template: string, packageRoot: string): string {
  const maxBytes = Number(process.env.CASE_INLINE_MAX_BYTES ?? 8192);

  return template.replace(INJECT_MARKER, (marker, relPath: string) => {
    if (!relPath) return marker;

    try {
      let content = readPackageAssetSync(relPath, { packageRoot });
      if (content.length > maxBytes) {
        content = content.slice(0, maxBytes) + '\n\n[truncated]';
        process.stderr.write(`[assembler] inlined doc truncated: ${relPath}\n`);
      }
      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[assembler] inline failed for ${relPath}: ${message}\n`);
      return marker;
    }
  });
}

function buildRevisionContext(revision: RevisionRequest): string {
  const lines = [
    `## REVISION CONTEXT — ${revision.source} found fixable issues (cycle ${revision.cycle})`,
    '',
    `**Source:** ${revision.source}`,
    `**Summary:** ${revision.summary}`,
    '',
    '**Failed categories:**',
    ...revision.failedCategories.map((c) => `- **${c.category}** (${c.verdict}): ${c.detail}`),
    '',
    '**Suggested focus:**',
    ...revision.suggestedFocus.map((f) => `- ${f}`),
    '',
    'Address these specific issues. Do NOT redo the entire implementation.',
    'Make targeted fixes, re-run validation, and commit.',
    '',
  ];
  return lines.join('\n');
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
  if (config.project) {
    lines.push(`- **Repo type**: ${config.project.type ?? 'app'}`);
    lines.push(`- **Package manager**: ${config.project.packageManager}`);
  }
  lines.push('');

  switch (role) {
    case 'implementer':
      appendImplementerContext(lines, config, task, repoContext);
      break;

    case 'verifier':
      // Deliberately minimal — fresh-context testing
      appendProjectCommands(lines, config);
      break;

    case 'reviewer':
      appendReviewerContext(lines, repoContext);
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

function appendProjectCommands(lines: string[], config: PipelineConfig): void {
  if (!config.project?.commands || Object.keys(config.project.commands).length === 0) return;
  lines.push('### Project Commands');
  lines.push('');
  for (const [name, command] of Object.entries(config.project.commands)) {
    lines.push(`- **${name}**: \`${command}\``);
  }
  lines.push('');
}

function appendImplementerContext(
  lines: string[],
  config: PipelineConfig,
  task: TaskJson,
  repoContext: RepoContext,
): void {
  appendProjectCommands(lines, config);

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

function appendReviewerContext(lines: string[], repoContext: RepoContext): void {
  if (!repoContext.goldenPrinciples) return;
  lines.push('### Golden Principles');
  lines.push('');
  lines.push(repoContext.goldenPrinciples);
  lines.push('');
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
