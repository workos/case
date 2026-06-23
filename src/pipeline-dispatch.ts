import type { AgentName, AgentResult, PipelineConfig, PipelinePhase, RevisionRequest, ScoutFindings } from './types.js';
import type { TaskStore } from './state/task-store.js';
import type { Notifier } from './notify.js';
import { runImplementPhase } from './phases/implement.js';
import { runScoutPhase } from './phases/scout.js';
import { runVerifyPhase } from './phases/verify.js';
import { runReviewPhase } from './phases/review.js';
import { runClosePhase } from './phases/close.js';
import { runRetrospectivePhase, type MetricsSnapshot } from './phases/retrospective.js';
import { projectMetrics } from './events/projections.js';
import { resolveOutcome } from './dag/outcome-table.js';
import { createLogger } from './util/logger.js';

const log = createLogger();

/**
 * Minimal node handle the dispatcher needs. The legacy executor passes a full
 * `DagNode` (assignable to this); the LangGraph engine passes a literal. Only
 * `phase` and `startedAt` are read.
 */
export interface DispatchNodeRef {
  phase: PipelinePhase;
  startedAt?: string;
}

export interface PipelineCallbacks {
  incrementHumanOverrides: () => void;
  outcome: () => 'completed' | 'failed';
  setOutcome: (o: 'completed' | 'failed') => void;
  setFailedAgent: (a: AgentName) => void;
  getScoutFindings: () => ScoutFindings | null;
  setScoutFindings: (f: ScoutFindings | null) => void;
}

/**
 * Validate a phase's typed outcome against the unified failure matrix. The
 * matrix is the source of truth for `(phase, outcome) → next-action`; this
 * call surfaces drift between a phase impl and the matrix immediately. The
 * legacy `nextPhase` field still drives control flow until the executor is
 * fully migrated.
 */
export function consultMatrix(outcome: import('./types.js').PhaseOutcome | undefined): void {
  if (!outcome) return;
  try {
    resolveOutcome(outcome.phase, outcome.outcome);
  } catch (err) {
    log.error('outcome matrix lookup failed', {
      phase: outcome.phase,
      outcome: outcome.outcome,
      error: (err as Error).message,
    });
  }
}

/**
 * Run a single pipeline phase and return its `AgentResult`. Engine-agnostic:
 * the legacy DAG executor and the LangGraph engine both dispatch through this
 * function so per-phase semantics (matrix consult, abort prompts, scout
 * findings hand-off, previousResults bookkeeping) stay identical across engines.
 */
export async function dispatchNode(
  node: DispatchNodeRef,
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
  notifier: Notifier,
  revision: RevisionRequest | undefined,
  callbacks: PipelineCallbacks,
): Promise<AgentResult> {
  switch (node.phase) {
    case 'scout': {
      const output = await runScoutPhase(config, store);
      consultMatrix(output.outcome);
      callbacks.setScoutFindings(output.findings);
      // Emit a lightweight audit event on the trace so cross-run analytics can
      // track scout coverage without reading the phase span payload.
      {
        const elapsedMs = output.result.summary.startsWith('[dry-run]')
          ? 0
          : Date.now() - Date.parse(node.startedAt ?? new Date().toISOString());
        config.langfuse?.event('scout_completed', {
          hasFindings: output.findings !== null,
          relevantFileCount: output.findings?.relevantFiles.length ?? 0,
          patternCount: output.findings?.patterns.length ?? 0,
          durationMs: Math.max(0, elapsedMs),
        });
      }
      // Scout is non-blocking: always surface a `completed` status so the
      // executor advances to implement_0 regardless of whether findings
      // were produced. The typed outcome (consulted above) records the
      // real success/failure for audit fidelity.
      return { ...output.result, status: 'completed' };
    }

    case 'implement': {
      if (revision) {
        await store.setPendingRevision(revision);
      }
      const output = await runImplementPhase(config, store, previousResults, revision, callbacks.getScoutFindings());
      consultMatrix(output.outcome);
      if (output.nextPhase === 'abort') {
        const choice = await handleFailure(notifier, config, 'implementer', output.result, [
          'Retry with guidance',
          'Abort',
        ]);
        if (choice === 'Abort') {
          callbacks.setOutcome('failed');
          callbacks.setFailedAgent('implementer');
          return output.result;
        }
        return { ...output.result, status: 'completed' };
      }
      await store.setPendingRevision(null);
      previousResults.set('implementer', output.result);
      return output.result;
    }

    case 'verify': {
      const output = await runVerifyPhase(config, store, previousResults);
      consultMatrix(output.outcome);
      if (output.nextPhase === 'abort') {
        const choice = await handleFailure(notifier, config, 'verifier', output.result, [
          'Re-implement and re-verify',
          'Skip verification',
          'Abort',
        ]);
        if (choice === 'Abort') {
          callbacks.setOutcome('failed');
          callbacks.setFailedAgent('verifier');
          return output.result;
        }
        return { ...output.result, status: 'completed' };
      }
      previousResults.set('verifier', output.result);
      return output.result;
    }

    case 'review': {
      const output = await runReviewPhase(config, store, previousResults);
      consultMatrix(output.outcome);
      if (output.nextPhase === 'abort') {
        const choice = await handleFailure(notifier, config, 'reviewer', output.result, [
          'Re-implement and re-review',
          'Override and continue',
          'Abort',
        ]);
        if (choice === 'Abort') {
          callbacks.setOutcome('failed');
          callbacks.setFailedAgent('reviewer');
          return output.result;
        }
        if (choice === 'Override and continue') {
          callbacks.incrementHumanOverrides();
        }
        return { ...output.result, status: 'completed' };
      }
      previousResults.set('reviewer', output.result);
      return output.result;
    }

    case 'close': {
      const output = await runClosePhase(config, store, previousResults);
      consultMatrix(output.outcome);
      if (output.nextPhase === 'abort') {
        const choice = await handleFailure(notifier, config, 'closer', output.result, ['Retry', 'Abort']);
        if (choice === 'Abort') {
          callbacks.setOutcome('failed');
          callbacks.setFailedAgent('closer');
          return output.result;
        }
        return { ...output.result, status: 'completed' };
      }
      const prUrl = output.result.artifacts.prUrl;
      if (prUrl) notifier.send(`PR created: ${prUrl}`);
      previousResults.set('closer', output.result);
      return output.result;
    }

    case 'retrospective': {
      const runStateSnapshot = config.runState!.getState();
      const metricsSnapshot: MetricsSnapshot = {
        revisionCycles: runStateSnapshot.revisionCycles,
        humanOverrides: 0,
        profile: runStateSnapshot.profile,
        evaluatorEffectiveness: projectMetrics(runStateSnapshot).evaluatorEffectiveness,
      };
      await runRetrospectivePhase(config, store, previousResults, callbacks.outcome(), undefined, metricsSnapshot);
      return {
        status: 'completed',
        summary: 'Retrospective complete',
        artifacts: {
          commit: null,
          filesChanged: [],
          testsPassed: null,
          screenshotUrls: [],
          evidenceMarkers: [],
          prUrl: null,
          prNumber: null,
        },
        error: null,
      };
    }

    default:
      throw new Error(`Unknown phase: ${node.phase}`);
  }
}

export async function handleFailure(
  notifier: Notifier,
  config: PipelineConfig,
  agent: AgentName,
  result: AgentResult,
  options: string[],
): Promise<string> {
  const errorMsg = result.error ?? result.summary ?? 'unknown error';
  const prompt = `${agent} failed: ${errorMsg}`;
  return notifier.askUser(prompt, options);
}
