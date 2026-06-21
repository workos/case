import { StateGraph, START, END } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { AgentName, AgentResult, PipelinePhase, PipelineProfile, RevisionRequest, TaskStatus } from '../types.js';
import { PROFILE_PHASES } from '../types.js';
import type { Notifier } from '../notify.js';
import type { EventAppender } from '../events/appender.js';
import type { TaskStore } from '../state/task-store.js';
import type { DispatchNodeRef } from '../pipeline-dispatch.js';
import { projectNodeState } from './projection.js';
import { computeFingerprint, fingerprintsMatch } from '../dag/fingerprint.js';
import { mergeRevisionRequests } from '../dag/merge.js';
import { createLogger } from '../util/logger.js';
import { CaseGraphState, type CaseGraphStateType } from './state.js';

const log = createLogger();

export type DispatchFn = (node: DispatchNodeRef, revision?: RevisionRequest) => Promise<AgentResult>;

export interface LangGraphEngineArgs {
  profile: PipelineProfile;
  maxRevisionCycles: number;
  appender: EventAppender;
  /** Task-grain store — receives the node-direct td mirror (RFC §1.3 step 2). */
  store: TaskStore;
  /** Repo data dir; marker files are written under `<caseRoot>/.case/<task>/`. */
  caseRoot: string;
  notifier: Notifier;
  /** Bound per-phase dispatcher (the engine-agnostic seam in pipeline-dispatch). */
  dispatch: DispatchFn;
  /**
   * Mark the run failed on the shared pipeline closure (sets outcome +
   * failedAgent). Called whenever a dispatched phase returns a non-completed
   * result — mirrors the legacy executor's end-of-run failed-node scan.
   */
  onPhaseFailed: (agent: AgentName) => void;
  /** Seed from a td-persisted pending revision (resume-at-implement). */
  initialPendingRevision?: RevisionRequest | null;
  /**
   * Engine-state checkpointer (RFC §5 decision 1). When present, the graph is
   * compiled with it and the run resumes from a prior interrupted checkpoint.
   * Absent → 1.1 behavior (fresh in-memory run, no crash resume).
   */
  checkpointer?: BaseCheckpointSaver;
  /** Stable per-task thread key for the checkpointer. Required with `checkpointer`. */
  threadId?: string;
}

/**
 * Maps a running phase to the TaskStatus the td mirror should show. Exported for
 * the status-projection spec (ported from the legacy `projectStatusFromGraph`):
 * the LangGraph path emits status per-phase rather than scanning a node graph,
 * so the legacy concurrent `evaluating` status is intentionally absent (RFC §0
 * 1.1 deviation 3).
 */
export function phaseStatus(phase: PipelinePhase, state: CaseGraphStateType): TaskStatus | null {
  switch (phase) {
    case 'implement':
      return 'implementing';
    case 'verify':
      return 'verifying';
    case 'review':
      return 'reviewing';
    case 'close':
      return 'closing';
    case 'retrospective':
      // After a successful close, the PR is open while the retrospective runs.
      return state.last?.phase === 'close' && state.last.status === 'completed' ? 'pr-opened' : null;
    default:
      // scout has no dedicated status — the run stays `active`.
      return null;
  }
}

function rubricFailed(result: AgentResult): boolean {
  return result.rubric?.categories.some((c) => c.verdict === 'fail') ?? false;
}

/**
 * Derive a fingerprint from a single evaluator's revision request. Mirrors the
 * legacy executor's `computeFingerprintFromRequests` (returns undefined when
 * there are no failed categories to hash).
 */
function fingerprintFor(request: RevisionRequest): string | undefined {
  const failedCategories = request.failedCategories.map((c) => c.category);
  if (failedCategories.length === 0) return undefined;
  return computeFingerprint({ failedCategories, errorSummary: request.summary ?? '' });
}

/**
 * Run a Case pipeline through a LangGraph `StateGraph`. Drives the same
 * scout → implement → verify → review → close → retrospective flow (with the
 * revision loop, fingerprint short-circuit, and revision-budget cap) as the
 * legacy DAG executor, emitting the identical event stream through the shared
 * `EventAppender` so td-status, evidence markers, metrics, and `runs.jsonl`
 * stay correct.
 */
export async function executeLangGraph(args: LangGraphEngineArgs): Promise<void> {
  const { appender, store, caseRoot, notifier, dispatch, onPhaseFailed, maxRevisionCycles } = args;
  const phases = PROFILE_PHASES[args.profile];
  const hasScout = phases.includes('scout');
  const hasVerify = phases.includes('verify');

  let currentStatus: TaskStatus = appender.getState().status;

  async function emitStatus(phase: PipelinePhase, state: CaseGraphStateType): Promise<void> {
    const next = phaseStatus(phase, state);
    if (!next || next === currentStatus) return;
    await appender.append({ event: 'status_changed', from: currentStatus, to: next });
    currentStatus = next;
  }

  /** Shared per-phase wrapper: events + notifier + heartbeat around dispatch. */
  async function runPhase(
    phase: PipelinePhase,
    agent: AgentName | 'retrospective',
    state: CaseGraphStateType,
    revision?: RevisionRequest,
  ): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    await appender.append({ event: 'phase_start', phase, agent });
    notifier.phaseStart(phase, agent);
    await emitStatus(phase, state);
    // Node-direct td mirror at phase start: surfaces the running phase + its new
    // status to td/humans before the (possibly long) dispatch (RFC §1.3 step 2).
    await projectNodeState(appender.getState(), store, caseRoot);

    notifier.startHeartbeat();
    let result: AgentResult;
    try {
      result = await dispatch({ phase, startedAt }, revision);
    } finally {
      notifier.stopHeartbeat();
    }

    const elapsed = Date.now() - Date.parse(startedAt);
    const outcome = result.status === 'completed' ? 'completed' : 'failed';
    await appender.append({ event: 'phase_end', phase, agent, outcome, durationMs: elapsed, result });
    // Node-direct td mirror + evidence markers on completion: agent status flips
    // to completed/failed and a passed verify/review drops its tested/reviewed
    // marker file in the same tick.
    await projectNodeState(appender.getState(), store, caseRoot);
    notifier.phaseEnd(phase, agent, elapsed, outcome);
    if (outcome === 'failed' && agent !== 'retrospective') onPhaseFailed(agent);
    return result;
  }

  // --- nodes -------------------------------------------------------------

  async function scoutNode(state: CaseGraphStateType): Promise<Partial<CaseGraphStateType>> {
    const result = await runPhase('scout', 'scout', state);
    return {
      last: { phase: 'scout', status: result.status === 'completed' ? 'completed' : 'failed', rubricFailed: false },
    };
  }

  async function implementNode(state: CaseGraphStateType): Promise<Partial<CaseGraphStateType>> {
    const result = await runPhase('implement', 'implementer', state, state.pendingRevision ?? undefined);
    return {
      last: { phase: 'implement', status: result.status === 'completed' ? 'completed' : 'failed', rubricFailed: false },
      pendingRevision: null,
    };
  }

  function evaluatorNode(phase: 'verify' | 'review', agent: AgentName) {
    return async (state: CaseGraphStateType): Promise<Partial<CaseGraphStateType>> => {
      const result = await runPhase(phase, agent, state);
      const failed = result.status !== 'completed';
      const failedRubric = !failed && rubricFailed(result);
      return {
        last: { phase, status: failed ? 'failed' : 'completed', rubricFailed: failedRubric },
        evaluator: failedRubric ? { phase, result } : null,
      };
    };
  }

  /**
   * Revision decision node. Reads the failing evaluator's output and decides
   * whether to spend another implement cycle or close with warnings. Mirrors
   * the legacy executor's `handleEvaluatorPairCompletion` for the sequential
   * (one-evaluator-per-cycle) case the tiny/standard profiles exercise.
   */
  async function reviseNode(state: CaseGraphStateType): Promise<Partial<CaseGraphStateType>> {
    const slot = state.evaluator;
    if (!slot) {
      // Defensive: no evaluator output to act on — close out.
      return { decision: 'close' };
    }
    const c = state.cycle;
    const source: 'verifier' | 'reviewer' = slot.phase === 'verify' ? 'verifier' : 'reviewer';
    const request: RevisionRequest = {
      source,
      failedCategories: slot.result.rubric!.categories.filter((cat) => cat.verdict === 'fail'),
      summary: slot.result.summary,
      suggestedFocus: slot.result.artifacts?.filesChanged ?? [],
      cycle: c + 1,
    };
    const fingerprint = fingerprintFor(request);

    // When revision is denied, the legacy executor still runs the *current*
    // cycle's review (if the trigger was a verify failure) before closing —
    // skipping the next cycle unblocks the verify→review edge. A review trigger
    // means review already ran, so close directly.
    const denied: Partial<CaseGraphStateType> = {
      decision: slot.phase === 'verify' ? 'review' : 'close',
      revisionClosed: true,
    };

    // Revision budget: implement nodes exist for cycles 0..maxRevisionCycles, so
    // a next cycle is available iff c + 1 <= maxRevisionCycles.
    if (c + 1 > maxRevisionCycles) {
      await appender.append({ event: 'revision_budget_exhausted', cycles: c + 1 });
      notifier.send(
        `Revision budget exhausted after cycle ${c}. ${source} found issues but no revision cycles remain. Proceeding with warnings.`,
      );
      return denied;
    }

    // Fingerprint short-circuit: the same failure signature two cycles running
    // is unlikely to clear with another pass.
    const previousFingerprint = c - 1 >= 0 ? state.fingerprints[c - 1] : undefined;
    if (fingerprint && previousFingerprint && fingerprintsMatch(fingerprint, previousFingerprint)) {
      await appender.append({ event: 'fingerprint_match', cycle: c + 1, fingerprint, previousCycle: c - 1 });
      await appender.append({ event: 'revision_budget_exhausted', cycles: c + 1 });
      notifier.send(
        `Revision budget exhausted: fingerprint match (cycle ${c} matched cycle ${c - 1}, ${fingerprint}). Aborting revision cycle ${c + 1} and proceeding with warnings.`,
      );
      return { ...denied, fingerprints: { [c]: fingerprint } };
    }

    const merged = mergeRevisionRequests([request]);
    if (fingerprint) merged.fingerprint = fingerprint;
    await appender.append({
      event: 'revision_requested',
      source: merged.source,
      cycle: c + 1,
      failedCategories: merged.failedCategories,
    });
    notifier.send(`Revision cycle ${c + 1}: ${source} found fixable issues, re-implementing`);

    return {
      decision: 'implement',
      pendingRevision: merged,
      cycle: c + 1,
      revisionCycles: c + 1,
      evaluator: null,
      ...(fingerprint ? { fingerprints: { [c]: fingerprint } } : {}),
    };
  }

  async function closeNode(state: CaseGraphStateType): Promise<Partial<CaseGraphStateType>> {
    const result = await runPhase('close', 'closer', state);
    return {
      last: { phase: 'close', status: result.status === 'completed' ? 'completed' : 'failed', rubricFailed: false },
    };
  }

  async function retrospectiveNode(state: CaseGraphStateType): Promise<Partial<CaseGraphStateType>> {
    await runPhase('retrospective', 'retrospective', state);
    return {};
  }

  // --- routers -----------------------------------------------------------

  const entry = (state: CaseGraphStateType): string =>
    state.pendingRevision ? 'implement' : hasScout ? 'scout' : 'implement';

  const afterImplement = (state: CaseGraphStateType): string => {
    if (state.last?.status === 'failed') return 'retrospective';
    return hasVerify ? 'verify' : 'review';
  };

  const afterVerify = (state: CaseGraphStateType): string => {
    if (state.last?.status === 'failed') return 'retrospective';
    return state.last?.rubricFailed ? 'revise' : 'review';
  };

  const afterReview = (state: CaseGraphStateType): string => {
    if (state.last?.status === 'failed') return 'retrospective';
    // A trailing review after revision was denied can no longer revise.
    if (state.revisionClosed) return 'close';
    return state.last?.rubricFailed ? 'revise' : 'close';
  };

  const afterRevise = (state: CaseGraphStateType): string => state.decision ?? 'close';

  // --- graph assembly ----------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = new StateGraph(CaseGraphState) as any;

  if (hasScout) g.addNode('scout', scoutNode);
  g.addNode('implement', implementNode);
  if (hasVerify) g.addNode('verify', evaluatorNode('verify', 'verifier'));
  g.addNode('review', evaluatorNode('review', 'reviewer'));
  g.addNode('revise', reviseNode);
  g.addNode('close', closeNode);
  g.addNode('retrospective', retrospectiveNode);

  const entryTargets = hasScout ? { scout: 'scout', implement: 'implement' } : { implement: 'implement' };
  g.addConditionalEdges(START, entry, entryTargets);
  if (hasScout) g.addEdge('scout', 'implement');

  g.addConditionalEdges(
    'implement',
    afterImplement,
    hasVerify
      ? { verify: 'verify', retrospective: 'retrospective' }
      : { review: 'review', retrospective: 'retrospective' },
  );
  if (hasVerify) {
    g.addConditionalEdges('verify', afterVerify, {
      review: 'review',
      revise: 'revise',
      retrospective: 'retrospective',
    });
  }
  g.addConditionalEdges('review', afterReview, {
    close: 'close',
    revise: 'revise',
    retrospective: 'retrospective',
  });
  g.addConditionalEdges('revise', afterRevise, { implement: 'implement', review: 'review', close: 'close' });
  g.addEdge('close', 'retrospective');
  g.addEdge('retrospective', END);

  const { checkpointer, threadId } = args;
  const compiled = checkpointer ? g.compile({ checkpointer }) : g.compile();

  const seed = args.initialPendingRevision;
  const initial: Partial<CaseGraphStateType> = seed
    ? { pendingRevision: seed, cycle: seed.cycle ?? 1, revisionCycles: seed.cycle ?? 1 }
    : {};

  // recursionLimit as a runaway backstop only (RFC §5 decision 4); the explicit
  // revision-budget cap is the real guard.
  const runConfig: Record<string, unknown> = { recursionLimit: (maxRevisionCycles + 2) * 8 };
  if (checkpointer && threadId) runConfig.configurable = { thread_id: threadId };

  // Resume decision. `deleteThread` runs only on normal completion, so any
  // checkpoint that still has pending next-nodes is a genuinely interrupted run
  // (crash/abort) — this mirrors the legacy `outcome === 'running'` resume gate.
  // Resuming runs invoke with `null` (continue from saved state); the td-seeded
  // `initial` applies to fresh runs only.
  let resuming = false;
  if (checkpointer && threadId) {
    const snapshot = await compiled.getState(runConfig);
    resuming = snapshot.next.length > 0;
    if (!resuming && snapshot.config.configurable?.checkpoint_id) {
      // Stale terminal checkpoint (e.g. a crash during a prior cleanup): clear it
      // so this run starts genuinely fresh rather than re-applying a done state.
      await checkpointer.deleteThread(threadId);
    }
  }

  log.info('langgraph engine started', {
    profile: args.profile,
    maxRevisionCycles,
    seeded: Boolean(seed),
    resuming,
  });
  if (resuming) notifier.send('Resuming interrupted run from checkpoint.');

  await compiled.invoke(resuming ? null : initial, runConfig);

  // Reached END normally — drop the thread so a future run of this task starts
  // fresh. Only an escaping error/abort leaves a resumable checkpoint behind.
  if (checkpointer && threadId) await checkpointer.deleteThread(threadId);
}
