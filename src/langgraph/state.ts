import { Annotation } from '@langchain/langgraph';
import type { AgentResult, PipelinePhase, RevisionRequest } from '../types.js';

/**
 * The phase that just completed, plus the routing-relevant facts the
 * conditional edges key off. `status` mirrors the legacy executor's node
 * state (`completed` iff the agent returned `status: 'completed'`);
 * `rubricFailed` is true when an evaluator returned a rubric with ≥1 `fail`
 * verdict (the revision trigger).
 */
export interface LastPhase {
  phase: PipelinePhase;
  status: 'completed' | 'failed';
  rubricFailed: boolean;
}

/** The failing evaluator's output, handed to the `revise` node. */
export interface EvaluatorSlot {
  phase: 'verify' | 'review';
  result: AgentResult;
}

const replace = <T>() => ({ reducer: (_a: T, b: T) => b });

/**
 * LangGraph state channels for a Case run. These hold *orchestration* state
 * only (cycle counters, the pending revision, per-cycle fingerprints, routing
 * breadcrumbs). Agent context (scout findings, previousResults) and run-level
 * outcome stay in the shared pipeline closure exactly as the legacy executor
 * keeps them, so per-phase semantics are identical across engines.
 *
 * In Phase 1.2 this is what the SQLite checkpointer snapshots for resume.
 */
export const CaseGraphState = Annotation.Root({
  /** 0-based implement/verify/review cycle currently in flight. */
  cycle: Annotation<number>({ ...replace<number>(), default: () => 0 }),
  /** Number of revision cycles taken (mirrors `PipelineState.revisionCycles`). */
  revisionCycles: Annotation<number>({ ...replace<number>(), default: () => 0 }),
  /** Revision to apply on the next implement, or null. Cleared once consumed. */
  pendingRevision: Annotation<RevisionRequest | null>({
    ...replace<RevisionRequest | null>(),
    default: () => null,
  }),
  /** Per-cycle failure fingerprints, keyed by the cycle that produced them. */
  fingerprints: Annotation<Record<number, string>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  /** The phase that just ran (drives conditional edges). */
  last: Annotation<LastPhase | null>({ ...replace<LastPhase | null>(), default: () => null }),
  /** The evaluator output awaiting a revision decision, or null. */
  evaluator: Annotation<EvaluatorSlot | null>({ ...replace<EvaluatorSlot | null>(), default: () => null }),
  /** `revise` node's verdict: re-implement, run the trailing review, or close. */
  decision: Annotation<'implement' | 'review' | 'close' | null>({
    ...replace<'implement' | 'review' | 'close' | null>(),
    default: () => null,
  }),
  /**
   * Set once revision is denied (budget exhausted / fingerprint match). Mirrors
   * the legacy executor: a denied *verify* failure still runs the current
   * cycle's review before closing, but that review can no longer trigger a
   * revision — this flag forces the post-review edge straight to `close`.
   */
  revisionClosed: Annotation<boolean>({ ...replace<boolean>(), default: () => false }),
});

export type CaseGraphStateType = typeof CaseGraphState.State;
