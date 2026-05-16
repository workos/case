import type { AgentName, AgentResult, PipelineConfig, RevisionRequest } from './types.js';
import { PROFILE_PHASES } from './types.js';
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
import type { PipelineGraph } from './dag/types.js';

const log = createLogger();

export async function runPipeline(config: PipelineConfig): Promise<void> {
  // TaskStore reads scripts/task-status.sh from the package; task JSON itself lives under dataDir.
  const store = new TaskStore(config.taskJsonPath, config.packageRoot);
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

  // Event log is mutable runtime state — lives under dataDir/.case/<taskId>/events/.
  const appender = new EventAppender(config.dataDir, task.id, runId, store);
  config.eventAppender = appender;

  const plan = generatePlan(task, config, runId);

  const { mkdir: mkdirPlan, writeFile: writePlan } = await import('node:fs/promises');
  const { resolve: resolvePlan } = await import('node:path');
  // Plan + event log live under dataDir/.case/<taskId>/ — mutable runtime state.
  const planDir = resolvePlan(config.dataDir, '.case', task.id);
  await mkdirPlan(planDir, { recursive: true });
  await writePlan(resolvePlan(planDir, 'plan.json'), JSON.stringify(plan, null, 2));

  const graph = buildGraph(profile, maxRevisionCycles, { approve: config.approve });

  // Crash recovery: restore graph state from event log if a prior run didn't complete
  const existingEventLogPath = resolvePlan(config.dataDir, '.case', task.id, 'events');
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

  let initialRevisionRequests: Map<number, RevisionRequest[]> | undefined;

  if (!resumed) {
    await appender.append({ event: 'pipeline_start', taskId: task.id, profile, plan });

    if (task.pendingRevision) {
      const revCycle = task.pendingRevision.cycle ?? 1;
      const prevCycle = revCycle - 1;
      markCyclesCompleted(graph, profile, 0, prevCycle);
      seedPendingRevision(graph, task.pendingRevision);
      initialRevisionRequests = new Map([[prevCycle, [task.pendingRevision]]]);
      const state = appender.getState();
      state.revisionCycles = revCycle;
      state.pendingRevision = task.pendingRevision;
      resumed = true;
    } else if (task.status !== 'active') {
      seedGraphFromTaskStatus(graph, profile, task.status);
      resumed = true;
    }
  }

  // Prompt versions / run log live under docs/ — static package assets.
  const promptVersions = await getCurrentPromptVersions(config.packageRoot);
  let outcome: 'completed' | 'failed' = 'completed';
  let failedAgent: AgentName | undefined;

  log.info('pipeline started', { phase: 'dag', mode: config.mode, task: task.id, runId });

  const ctx: ExecuteGraphContext = {
    graph,
    appender,
    config,
    notifier,
    initialRevisionRequests,
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
        hasVerify: PROFILE_PHASES[profile].includes('verify'),
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

  if (approvalDecision === null && !config.approve) {
    approvalDecision = 'skipped';
  }

  await appender.append({ event: 'pipeline_end', outcome, failedAgent, durationMs: totalDurationMs });

  const runMetrics = projectMetrics(appender.getState());
  runMetrics.promptVersions = promptVersions;
  runMetrics.approvalDecision = approvalDecision;
  runMetrics.approvalTimeMs = approvalTimeMs;
  runMetrics.humanOverrides = humanOverrides;
  runMetrics.humanRevisionCycles = humanRevisionCycles;
  if (humanRevisionCycles > 0) {
    runMetrics.revisionCycles = Math.max(runMetrics.revisionCycles, humanRevisionCycles);
  }
  const priorRunId = await findPriorRunId(config.packageRoot, task.id);
  await writeRunMetrics(config.packageRoot, task.id, config.repoName, runMetrics, {
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
  hasVerify: boolean;
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
      if (revision) {
        await store.setPendingRevision(revision);
      }
      const output = await runImplementPhase(config, store, previousResults, revision);
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

      const maxCycles = config.maxRevisionCycles ?? 2;
      const approveStart = Date.now();
      let usedCycles = 0;

      for (;;) {
        const approveOutput = await runApprovePhase(config, store, previousResults, notifier);

        if (approveOutput.nextPhase === 'abort') {
          callbacks.setApprovalDecision('rejected');
          callbacks.setApprovalTimeMs(Date.now() - approveStart);
          callbacks.setOutcome('failed');
          return approveOutput.result;
        }

        if (approveOutput.nextPhase === 'close' || approveOutput.nextPhase === 'approve') {
          callbacks.setApprovalDecision('approved');
          callbacks.setApprovalTimeMs(Date.now() - approveStart);
          return approveOutput.result;
        }

        if (usedCycles >= maxCycles) {
          notifier.send(`Revision budget exhausted (${maxCycles} cycles used). Proceeding to close.`);
          callbacks.setApprovalDecision('approved');
          callbacks.setApprovalTimeMs(Date.now() - approveStart);
          return approveOutput.result;
        }

        callbacks.incrementHumanRevisionCycles();
        usedCycles++;

        if (approveOutput.nextPhase === 'implement') {
          notifier.send(`Human requested changes: ${approveOutput.revision?.summary ?? 'no details'}`);
          await dispatchNode(
            { ...node, phase: 'implement', agent: 'implementer', id: `implement_${usedCycles}` },
            config, store, previousResults, notifier, approveOutput.revision, callbacks,
          );
        } else {
          notifier.send('Manual edit complete — re-verifying.');
        }

        if (callbacks.hasVerify || approveOutput.nextPhase === 'verify') {
          await dispatchNode(
            { ...node, phase: 'verify', agent: 'verifier', id: `verify_${usedCycles}` },
            config, store, previousResults, notifier, undefined, callbacks,
          );
        }

        await dispatchNode(
          { ...node, phase: 'review', agent: 'reviewer', id: `review_${usedCycles}` },
          config, store, previousResults, notifier, undefined, callbacks,
        );
      }
    }
    case 'close': {
      const output = await runClosePhase(config, store, previousResults);
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

function markCyclesCompleted(
  graph: PipelineGraph,
  profile: import('./types.js').PipelineProfile,
  fromCycle: number,
  toCycle: number,
): void {
  const phases = PROFILE_PHASES[profile];
  for (let c = fromCycle; c <= toCycle; c++) {
    for (const phase of ['implement', 'verify', 'review']) {
      if (phase === 'verify' && !phases.includes('verify')) continue;
      const node = graph.nodes.get(`${phase}_${c}`);
      if (node && node.state === 'pending') {
        node.state = 'completed';
        node.startedAt = new Date().toISOString();
        node.completedAt = new Date().toISOString();
      }
    }
  }
}

function seedGraphFromTaskStatus(
  graph: PipelineGraph,
  profile: import('./types.js').PipelineProfile,
  status: import('./types.js').TaskStatus,
): void {
  const phaseOrder = ['implementing', 'verifying', 'reviewing', 'closing'] as const;
  const phaseToNode: Record<string, string> = {
    implementing: 'implement_0',
    verifying: 'verify_0',
    reviewing: 'review_0',
    closing: 'close',
  };

  for (const phase of phaseOrder) {
    if (phase === status) break;
    const nodeId = phaseToNode[phase];
    if (!nodeId) continue;
    if (phase === 'verifying' && !PROFILE_PHASES[profile].includes('verify')) continue;
    const node = graph.nodes.get(nodeId);
    if (node && node.state === 'pending') {
      node.state = 'completed';
      node.startedAt = new Date().toISOString();
      node.completedAt = new Date().toISOString();
    }
  }
}

function seedPendingRevision(graph: PipelineGraph, revision: RevisionRequest): void {
  const sourceCycle = (revision.cycle ?? 1) - 1;
  const sourcePhase = revision.source === 'reviewer' ? 'review' : 'verify';
  const sourceNode = graph.nodes.get(`${sourcePhase}_${sourceCycle}`);
  if (sourceNode) {
    sourceNode.result = {
      status: 'completed',
      summary: revision.summary,
      artifacts: {
        commit: null,
        filesChanged: revision.suggestedFocus,
        testsPassed: null,
        screenshotUrls: [],
        evidenceMarkers: [],
        prUrl: null,
        prNumber: null,
      },
      rubric: {
        role: revision.source === 'reviewer' ? 'reviewer' : 'verifier',
        categories: revision.failedCategories,
      },
      error: null,
    };
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
