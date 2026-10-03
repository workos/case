import type { AgentName, PipelinePhase, PipelineProfile, RubricCategory } from '../types.js';
import type { PlanArtifact } from '../events/plan.js';
import type { PhaseState, PipelineState } from '../events/types.js';

/**
 * In-memory run-state container (Phase 2.2).
 *
 * Replaces the `EventAppender` + `reduceEvents` pair. Phase 1.3 had the LangGraph
 * engine *drive* `PipelineState` by appending granular events and *read it back*
 * via `appender.getState()` for the node-direct td/marker projection, the run
 * metrics, and the retrospective snapshot. 2.2 deletes the JSONL event log and its
 * schema/reducer, so the transition logic that built `PipelineState` lives here as
 * plain typed mutators instead — no event envelope, no file I/O, no replay.
 *
 * The {@link PipelineState} shape is unchanged, so every downstream projection
 * (`projectTaskJson` / `projectMarkers` / `projectMetrics`) is identical by
 * construction. Observability moved to Langfuse (the per-run trace); this object
 * is process-local orchestration/projection state, rebuilt fresh each run.
 *
 * Single-owner, mutate-in-place: the reducer cloned state for replay immutability,
 * but there is exactly one writer (the engine) and the readers take a live
 * snapshot via {@link getState}. `projectNodeState` still mutates `markers`
 * directly to dedupe marker writes — unchanged from 1.3.
 */
export class RunState {
  private readonly state: PipelineState;
  private sequence = 0;

  constructor(args: { runId: string; taskId: string; profile: PipelineProfile; plan: PlanArtifact }) {
    this.state = {
      runId: args.runId,
      taskId: args.taskId,
      profile: args.profile,
      plan: args.plan,
      status: 'active',
      phases: new Map(),
      currentPhase: null,
      runningPhases: new Set(),
      revisionCycles: 0,
      pendingRevision: null,
      markers: new Set(),
      outcome: 'running',
      startedAt: new Date().toISOString(),
      lastSequence: 0,
    };
  }

  /** Phase key: terminal phases are singletons; cyclic phases key by revision cycle. */
  private phaseKey(phase: PipelinePhase): string {
    return isTerminalPhase(phase) ? phase : `${phase}_${this.state.revisionCycles}`;
  }

  startPhase(phase: PipelinePhase, agent: AgentName | 'retrospective'): void {
    const key = this.phaseKey(phase);
    this.state.phases.set(key, { phase, agent, status: 'running', startedAt: new Date().toISOString() });
    this.state.currentPhase = key;
    this.state.runningPhases.add(key);
    this.state.lastSequence = ++this.sequence;
  }

  endPhase(
    phase: PipelinePhase,
    _agent: AgentName | 'retrospective',
    outcome: 'completed' | 'failed' | 'skipped',
    durationMs: number,
    result?: PhaseState['result'],
  ): void {
    const key = this.phaseKey(phase);
    const phaseState =
      this.state.phases.get(key) ??
      (this.state.currentPhase ? this.state.phases.get(this.state.currentPhase) : undefined);
    if (phaseState) {
      phaseState.status = outcome === 'completed' ? 'completed' : outcome === 'skipped' ? 'skipped' : 'failed';
      phaseState.completedAt = new Date().toISOString();
      phaseState.durationMs = durationMs;
      if (result) phaseState.result = result;
    }
    this.state.runningPhases.delete(key);
    this.state.currentPhase =
      this.state.runningPhases.size > 0 ? [...this.state.runningPhases][this.state.runningPhases.size - 1] : null;
    this.state.lastSequence = ++this.sequence;
  }

  setStatus(to: PipelineState['status']): void {
    this.state.status = to;
    this.state.lastSequence = ++this.sequence;
  }

  requestRevision(source: 'verifier' | 'reviewer', cycle: number, failedCategories: RubricCategory[]): void {
    this.state.revisionCycles = cycle;
    this.state.pendingRevision = { source, failedCategories, summary: '', suggestedFocus: [], cycle };
    this.state.lastSequence = ++this.sequence;
  }

  end(outcome: 'completed' | 'failed', failedAgent: AgentName | undefined, durationMs: number): void {
    this.state.outcome = outcome;
    this.state.completedAt = new Date().toISOString();
    this.state.totalDurationMs = durationMs;
    if (failedAgent) this.state.failedAgent = failedAgent;
    this.state.lastSequence = ++this.sequence;
  }

  /**
   * Seed the cumulative revision-cycle count + pending revision from a td-persisted
   * resume (replaces the 1.3 in-place mutation of `getState()` in pipeline.ts). Used
   * only on a resumed run so metrics + the retrospective snapshot see the pre-crash
   * cycles even though no new revision is requested this run.
   */
  seedRevision(revision: import('../types.js').RevisionRequest): void {
    this.state.revisionCycles = revision.cycle ?? 1;
    this.state.pendingRevision = revision;
  }

  /** Live snapshot — the engine is the single writer; readers must not mutate (except the marker dedupe in projectNodeState). */
  getState(): PipelineState {
    return this.state;
  }
}

const TERMINAL_PHASES = new Set<string>(['close', 'retrospective']);

function isTerminalPhase(phase: string): boolean {
  return TERMINAL_PHASES.has(phase);
}
