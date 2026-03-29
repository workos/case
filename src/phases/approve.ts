import type { AgentName, AgentResult, PhaseOutput, PipelineConfig, RevisionRequest } from '../types.js';
import type { Notifier } from '../notify.js';
import { TaskStore } from '../state/task-store.js';
import { assembleEvidence } from './evidence-assembler.js';
import { runApprovalServer } from './approve-server.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/**
 * Approval gate — human decision point between review and close.
 *
 * Assembles evidence from prior phase results, starts a local web server
 * with the approval UI, and waits for the human's decision.
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

  // --- Assemble evidence ---
  const evidence = await assembleEvidence(config, store, previousResults);

  // --- Start approval server and wait for decision ---
  notifier.send(`Approval gate: opening browser for task ${evidence.task.id}`);
  const decision = await runApprovalServer(evidence);

  if (decision.decision === 'approve') {
    log.phase('approve', 'approved');
    return {
      result: synthesizeResult('completed', 'Human approved'),
      nextPhase: 'close',
    };
  }

  if (decision.decision === 'revise') {
    if (decision.manualEdit) {
      log.phase('approve', 'manual-edit-requested');
      notifier.send('Waiting for manual edits. Re-entering at verify when ready.');
      return {
        result: synthesizeResult('completed', 'Human will edit manually'),
        nextPhase: 'verify',
      };
    }

    const feedbackText = decision.feedback ?? 'No feedback provided';
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

  // Reject (or any unknown decision falls here as safe default)
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
