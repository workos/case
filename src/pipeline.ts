import type { AgentName, AgentResult, PipelineConfig, RevisionRequest } from './types.js';
import { TaskStore } from './state/task-store.js';
import { createNotifier, formatDuration } from './notify.js';
import { runImplementPhase } from './phases/implement.js';
import { runVerifyPhase } from './phases/verify.js';
import { runReviewPhase } from './phases/review.js';
import { runApprovePhase } from './phases/approve.js';
import { runClosePhase } from './phases/close.js';
import { runRetrospectivePhase, type MetricsSnapshot } from './phases/retrospective.js';
import { writeRunMetrics } from './metrics/writer.js';
import { getCurrentPromptVersions, findPriorRunId } from './versioning/prompt-tracker.js';
import { EventAppender } from './events/appender.js';
import { generatePlan } from './events/plan.js';
import { projectMetrics } from './events/projections.js';
import { PiRuntimeAdapter } from './agent/adapters/pi-adapter.js';
import { createLogger } from './util/logger.js';
import { buildGraph } from './dag/builder.js';
import { executeGraph, type ExecuteGraphContext } from './dag/executor.js';
import type { DagNode } from './dag/types.js';
import { loadEventsFromFile, reduceEvents } from './events/reducer.js';
import { restoreGraphState } from './dag/restore.js';

const log = createLogger();

export async function runPipeline(config: PipelineConfig): Promise<void> {
  const store = new TaskStore(config.taskJsonPath, config.caseRoot);
  const notifier = createNotifier(config.mode);
  const previousResults = new Map<AgentName, AgentResult>();

  config.onAgentHeartbeat = (elapsedMs) => {
    notifier.send(`  ... still running (${formatDuration(elapsedMs)})`);
  };

  const task = await store.read();
  const profile = task.profile ?? 'standard';
  const maxRevisionCycles = config.maxRevisionCycles ?? 2;

  let approvalDecision: 'approved' | 'revised' | 'rejected' | 'skipped' | null = null;
  let approvalTimeMs: number | null = null;
  let humanOverrides = 0;
  let humanRevisionCycles = 0;

  const runId = crypto.randomUUID();
  config.runtime ??= new PiRuntimeAdapter();

  const appender = new EventAppender(config.caseRoot, task.id, runId, store);
  config.eventAppender = appender;

  const plan = generatePlan(task, config, runId);

  const { mkdir: mkdirPlan, writeFile: writePlan } = await import('node:fs/promises');
  const { resolve: resolvePlan } = await import('node:path');
  const planDir = resolvePlan(config.caseRoot, '.case', task.id);
  await mkdirPlan(planDir, { recursive: true });
  await writePlan(resolvePlan(planDir, 'plan.json'), JSON.stringify(plan, null, 2));

  const graph = buildGraph(profile, maxRevisionCycles, { approve: config.approve });

  // Crash recovery: restore graph state from event log if a prior run didn't complete
  const existingEventLogPath = resolvePlan(config.caseRoot, '.case', task.id, 'events');
  let resumed = false;
  try {
    const { readdir: readdirFs } = await import('node:fs/promises');
    const files = await readdirFs(existingEventLogPath);
    const latestLog = files
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .pop();
    if (latestLog) {
      const events = await loadEventsFromFile(resolvePlan(existingEventLogPath, latestLog));
      if (events.length > 0) {
        const state = reduceEvents(events);
        // Resume if the prior run didn't complete (no pipeline_end event)
        if (state.outcome === 'running') {
          restoreGraphState(graph, state);
          appender.restoreState(state);
          resumed = true;
        }
      }
    }
  } catch {
    // No existing event log — fresh start
  }

  if (!resumed) {
    await appender.append({ event: 'pipeline_start', taskId: task.id, profile, plan });
  }

  const promptVersions = await getCurrentPromptVersions(config.caseRoot);
  let outcome: 'completed' | 'failed' = 'completed';
  let failedAgent: AgentName | undefined;

  log.info('pipeline started', { phase: 'dag', mode: config.mode, task: task.id, runId });

  const ctx: ExecuteGraphContext = {
    graph,
    appender,
    config,
    notifier,
    dispatchPhase: async (node: DagNode, revision?: RevisionRequest) => {
      return dispatchNode(node, config, store, previousResults, notifier, revision, {
        getApprovalDecision: () => approvalDecision,
        setApprovalDecision: (d) => {
          approvalDecision = d;
        },
        setApprovalTimeMs: (t) => {
          approvalTimeMs = t;
        },
        incrementHumanOverrides: () => {
          humanOverrides++;
        },
        incrementHumanRevisionCycles: () => {
          humanRevisionCycles++;
        },
        outcome: () => outcome,
        setOutcome: (o) => {
          outcome = o;
        },
        setFailedAgent: (a) => {
          failedAgent = a;
        },
      });
    },
  };

  await executeGraph(ctx);

  const totalDurationMs = Date.now() - Date.parse(appender.getState().startedAt);

  // Check if any node failed
  for (const [, node] of graph.nodes) {
    if (node.state === 'failed' && node.agent !== 'retrospective') {
      outcome = 'failed';
      failedAgent = node.agent as AgentName;
      break;
    }
  }

  await appender.append({ event: 'pipeline_end', outcome, failedAgent, durationMs: totalDurationMs });

  const runMetrics = projectMetrics(appender.getState());
  runMetrics.promptVersions = promptVersions;
  runMetrics.approvalDecision = approvalDecision;
  runMetrics.approvalTimeMs = approvalTimeMs;
  runMetrics.humanOverrides = humanOverrides;
  runMetrics.humanRevisionCycles = humanRevisionCycles;
  const priorRunId = await findPriorRunId(config.caseRoot, task.id);
  await writeRunMetrics(config.caseRoot, task.id, config.repoName, runMetrics, {
    priorRunId,
    parentTaskId: task.contractPath,
  });

  log.info('pipeline finished', {
    outcome,
    failedAgent,
    runId,
    totalDurationMs: runMetrics.totalDurationMs,
    eventLog: appender.path,
  });

  if (outcome === 'failed') {
    notifier.send(`Pipeline failed at ${failedAgent ?? 'unknown'} phase.`);
  } else {
    notifier.send('Pipeline completed successfully.');
  }
}

interface PipelineCallbacks {
  getApprovalDecision: () => string | null;
  setApprovalDecision: (d: 'approved' | 'revised' | 'rejected' | 'skipped') => void;
  setApprovalTimeMs: (t: number) => void;
  incrementHumanOverrides: () => void;
  incrementHumanRevisionCycles: () => void;
  outcome: () => 'completed' | 'failed';
  setOutcome: (o: 'completed' | 'failed') => void;
  setFailedAgent: (a: AgentName) => void;
}

async function dispatchNode(
  node: DagNode,
  config: PipelineConfig,
  store: TaskStore,
  previousResults: Map<AgentName, AgentResult>,
  notifier: ReturnType<typeof createNotifier>,
  revision: RevisionRequest | undefined,
  callbacks: PipelineCallbacks,
): Promise<AgentResult> {
  switch (node.phase) {
    case 'implement': {
      const output = await runImplementPhase(config, store, previousResults, revision);
      if (output.nextPhase === 'abort') {
        const choice = await handleFailure(notifier, config, 'implementer', output.result, [
          'Retry with guidance',
          'Abort',
        ]);
        if (choice === 'Abort') {
          callbacks.setOutcome('failed');
          callbacks.setFailedAgent('implementer');
        }
        return output.result;
      }
      await store.setPendingRevision(null);
      previousResults.set('implementer', output.result);
      return output.result;
    }

    case 'verify': {
      const output = await runVerifyPhase(config, store, previousResults);
      if (output.nextPhase === 'abort') {
        const choice = await handleFailure(notifier, config, 'verifier', output.result, [
          'Re-implement and re-verify',
          'Skip verification',
          'Abort',
        ]);
        if (choice === 'Abort') {
          callbacks.setOutcome('failed');
          callbacks.setFailedAgent('verifier');
        }
        return output.result;
      }
      previousResults.set('verifier', output.result);
      return output.result;
    }

    case 'review': {
      const output = await runReviewPhase(config, store, previousResults);
      if (output.nextPhase === 'abort') {
        const choice = await handleFailure(notifier, config, 'reviewer', output.result, [
          'Re-implement and re-review',
          'Override and continue',
          'Abort',
        ]);
        if (choice === 'Abort') {
          callbacks.setOutcome('failed');
          callbacks.setFailedAgent('reviewer');
        }
        return output.result;
      }
      previousResults.set('reviewer', output.result);
      return output.result;
    }

    case 'approve': {
      if (!config.approve || config.mode === 'unattended') {
        callbacks.setApprovalDecision('skipped');
        return {
          status: 'completed',
          summary: 'Approval skipped',
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
      const approveOutput = await runApprovePhase(config, store, previousResults, notifier);
      if (approveOutput.nextPhase === 'abort') {
        callbacks.setApprovalDecision('rejected');
        callbacks.setOutcome('failed');
        return approveOutput.result;
      }
      callbacks.setApprovalDecision('approved');
      return approveOutput.result;
    }

    case 'close': {
      const output = await runClosePhase(config, store, previousResults);
      if (output.nextPhase === 'abort') {
        const choice = await handleFailure(notifier, config, 'closer', output.result, ['Retry', 'Abort']);
        if (choice === 'Abort') {
          callbacks.setOutcome('failed');
          callbacks.setFailedAgent('closer');
        }
        return output.result;
      }
      const prUrl = output.result.artifacts.prUrl;
      if (prUrl) notifier.send(`PR created: ${prUrl}`);
      previousResults.set('closer', output.result);
      return output.result;
    }

    case 'retrospective': {
      const appenderState = config.eventAppender!.getState();
      const metricsSnapshot: MetricsSnapshot = {
        revisionCycles: appenderState.revisionCycles,
        humanOverrides: 0,
        profile: appenderState.profile,
        evaluatorEffectiveness: projectMetrics(appenderState).evaluatorEffectiveness,
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

async function handleFailure(
  notifier: ReturnType<typeof createNotifier>,
  config: PipelineConfig,
  agent: AgentName,
  result: AgentResult,
  options: string[],
): Promise<string> {
  const errorMsg = result.error ?? result.summary ?? 'unknown error';
  const prompt = `${agent} failed: ${errorMsg}`;
  return notifier.askUser(prompt, options);
}
