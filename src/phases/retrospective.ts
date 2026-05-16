import type { AgentName, AgentResult, PipelineConfig } from '../types.js';
import { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

export interface MetricsSnapshot {
  revisionCycles: number;
  humanOverrides: number;
  profile: import('../types.js').PipelineProfile;
  evaluatorEffectiveness: import('../types.js').EvaluatorEffectiveness;
}

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
  metricsSnapshot?: MetricsSnapshot,
): Promise<void> {
  log.phase('retrospective', 'started', { outcome, failedAgent });

  if (config.dryRun) {
    log.phase('retrospective', 'dry-run-skip');
    return;
  }

  const retroContext = [
    '## Pipeline Outcome',
    '',
    `- **Outcome**: ${outcome}`,
    failedAgent ? `- **Failed agent**: ${failedAgent}` : '',
    '',
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

  const { resolve } = await import('node:path');
  const template = await Bun.file(resolve(config.caseRoot, 'agents/retrospective.md')).text();

  const metricsContext = metricsSnapshot
    ? [
        '## Run Metrics (pre-finalization snapshot)',
        '',
        `- **Profile**: ${metricsSnapshot.profile}`,
        `- **Revision cycles**: ${metricsSnapshot.revisionCycles}`,
        `- **Human overrides**: ${metricsSnapshot.humanOverrides}`,
        `- **Revision fixed issues**: ${metricsSnapshot.evaluatorEffectiveness.revisionFixedIssues ?? 'N/A (no revision)'}`,
        `- **Skipped phases**: ${metricsSnapshot.evaluatorEffectiveness.skippedPhases.length > 0 ? metricsSnapshot.evaluatorEffectiveness.skippedPhases.join(', ') : 'none'}`,
        '',
        metricsSnapshot.evaluatorEffectiveness.verifierRubric
          ? `### Verifier Rubric\n\`\`\`json\n${JSON.stringify(metricsSnapshot.evaluatorEffectiveness.verifierRubric, null, 2)}\n\`\`\`\n`
          : '',
        metricsSnapshot.evaluatorEffectiveness.reviewerRubric
          ? `### Reviewer Rubric\n\`\`\`json\n${JSON.stringify(metricsSnapshot.evaluatorEffectiveness.reviewerRubric, null, 2)}\n\`\`\`\n`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

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
    metricsContext,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const spawn = config.runtime?.spawn.bind(config.runtime) ?? spawnAgent;
    await spawn({
      prompt,
      cwd: config.repoPath,
      agentName: 'retrospective',
      caseRoot: config.caseRoot,
      onHeartbeat: config.onAgentHeartbeat,
      traceWriter: config.traceWriter,
      eventAppender: config.eventAppender,
      phase: 'retrospective',
    });
    log.phase('retrospective', 'completed');
  } catch (err) {
    log.error('retrospective agent failed', { error: String(err) });
  }
}
