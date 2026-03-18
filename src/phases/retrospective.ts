import type { AgentName, AgentResult, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Step 9: Always runs — on success AND failure.
 * Awaited so the retrospective completes before the process exits.
 */
export async function runRetrospectivePhase(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
  outcome: 'completed' | 'failed',
  failedAgent?: AgentName,
): Promise<void> {
  log.phase('retrospective', 'started', { outcome, failedAgent });

  if (config.dryRun) {
    log.phase('retrospective', 'dry-run-skip');
    return;
  }

  // Build retrospective-specific context
  const retroContext = [
    '## Pipeline Outcome',
    '',
    `- **Outcome**: ${outcome}`,
    failedAgent ? `- **Failed agent**: ${failedAgent}` : '',
    '',
    // Include failed agent's AGENT_RESULT if available
    ...(failedAgent && previousResults.has(failedAgent)
      ? [
          `### ${failedAgent} AGENT_RESULT`,
          '',
          '```json',
          JSON.stringify(previousResults.get(failedAgent), null, 2),
          '```',
          '',
        ]
      : []),
  ]
    .filter(Boolean)
    .join('\n');

  // We reuse assemblePrompt with 'closer' role for minimal context,
  // then prepend the retrospective template manually since 'retrospective'
  // isn't in the AgentName type (not a pipeline agent)
  const { resolve } = await import('node:path');
  const template = await Bun.file(resolve(config.caseRoot, 'agents/retrospective.md')).text();

  const prompt = [
    template,
    '',
    '## Task Context',
    '',
    `- **Task file**: \`${config.taskMdPath}\``,
    `- **Task JSON**: \`${config.taskJsonPath}\``,
    `- **Target repo**: \`${config.repoPath}\``,
    `- **Repo name**: ${config.repoName}`,
    '',
    retroContext,
  ].join('\n');

  try {
    await spawnAgent({ prompt, cwd: config.repoPath, agentName: 'retrospective', caseRoot: config.caseRoot, onHeartbeat: config.onAgentHeartbeat });
    log.phase('retrospective', 'completed');
  } catch (err) {
    log.error('retrospective agent failed', { error: String(err) });
  }
}
