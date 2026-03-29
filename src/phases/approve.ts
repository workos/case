import type { AgentName, AgentResult, PhaseOutput, PipelineConfig, RevisionRequest } from '../types.js';
import type { Notifier } from '../notify.js';
import { TaskStore } from '../state/task-store.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Approval gate — human decision point between review and close.
 *
 * Collects evidence from prior phase results, prints a terminal summary,
 * and prompts for Approve / Request Changes / Reject.
 * Does NOT spawn an agent — the human IS the agent.
 */
export async function runApprovePhase(
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
  notifier: Notifier,
): Promise<PhaseOutput> {
  await store.setStatus('approving');
  log.phase('approve', 'started');

  if (config.dryRun) {
    log.phase('approve', 'dry-run-skip');
    return {
      result: synthesizeResult('completed', '[dry-run] approve phase skipped'),
      nextPhase: 'close',
    };
  }

  // --- Extract evidence from previous phase results ---
  const implResult = previousResults.get('implementer');
  const verifierResult = previousResults.get('verifier');
  const reviewerResult = previousResults.get('reviewer');

  const filesChanged = implResult?.artifacts.filesChanged ?? [];
  const testsPassed = implResult?.artifacts.testsPassed;
  const commit = implResult?.artifacts.commit;

  const verifierCategories = verifierResult?.rubric?.categories ?? [];
  const verifierPassCount = verifierCategories.filter((c) => c.verdict === 'pass').length;

  const reviewerCategories = reviewerResult?.rubric?.categories ?? [];
  const reviewerPassCount = reviewerCategories.filter((c) => c.verdict === 'pass').length;
  const findings = reviewerResult?.findings;

  // --- Print terminal summary ---
  const summary = [
    '=== Approval Gate ===',
    `Files changed: ${filesChanged.length}${filesChanged.length > 0 ? ` (${filesChanged.join(', ')})` : ''}`,
    `Commit: ${commit ?? 'N/A'}`,
    `Tests: ${testsPassed === true ? 'passed' : testsPassed === false ? 'failed' : 'N/A'}`,
    verifierCategories.length > 0
      ? `Verifier: ${verifierPassCount}/${verifierCategories.length} categories pass`
      : 'Verifier: skipped',
    findings
      ? `Reviewer: ${findings.critical} critical, ${findings.warnings} warnings`
      : reviewerCategories.length > 0
        ? `Reviewer: ${reviewerPassCount}/${reviewerCategories.length} categories pass`
        : 'Reviewer: N/A',
  ];

  notifier.send(summary.join('\n'));

  // --- Prompt for decision ---
  const choice = await notifier.askUser('Approve this work?', ['Approve', 'Request Changes', 'Reject']);

  if (choice === 'Approve') {
    log.phase('approve', 'approved');
    return {
      result: synthesizeResult('completed', 'Human approved'),
      nextPhase: 'close',
    };
  }

  if (choice === 'Request Changes') {
    const feedbackText = prompt('Describe what needs changing: ') ?? 'No feedback provided';
    const revision: RevisionRequest = {
      source: 'human',
      failedCategories: [],
      summary: feedbackText,
      suggestedFocus: [],
      cycle: 0, // pipeline's handleRevisionOutcome will set the real cycle number
    };
    log.phase('approve', 'revision-requested', { feedback: feedbackText });
    return {
      result: synthesizeResult('completed', `Human requested changes: ${feedbackText}`),
      nextPhase: 'implement',
      revision,
    };
  }

  // Reject (or any unknown choice falls here as safe default)
  log.phase('approve', 'rejected');
  return {
    result: synthesizeResult('failed', 'Human rejected'),
    nextPhase: 'abort',
  };
}

function synthesizeResult(status: 'completed' | 'failed', summary: string): AgentResult {
  return {
    status,
    summary,
    artifacts: {
      commit: null,
      filesChanged: [],
      testsPassed: null,
      screenshotUrls: [],
      evidenceMarkers: [],
      prUrl: null,
      prNumber: null,
    },
    error: status === 'failed' ? summary : null,
  };
}
