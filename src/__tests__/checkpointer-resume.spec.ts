import { describe, it, expect } from 'bun:test';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { executeLangGraph, type DispatchFn } from '../langgraph/engine.js';
import type { AgentResult, RevisionRequest } from '../types.js';

/**
 * Checkpointer resume parity (Phase 1.2 acceptance; Phase 2.2 re-pointed off the
 * deleted `reduceEvents` oracle).
 *
 * A run is killed mid-`implement_1` (the implementer throws on the revision
 * cycle, escaping `invoke` exactly as a process crash would). A *second*
 * `executeLangGraph` over the SAME checkpointer + thread resumes. We assert the
 * restored run:
 *   1. re-enters at `implement` (not `scout`) — it did not restart from the top,
 *   2. carries the restored pending revision into that implement, and
 *   3. that restored revision is the verifier failure from cycle 0 → cycle 1
 *      (the crash point the dispatch script injects) — i.e. the checkpointer
 *      snapshot preserves (revisionCycles, pendingRevision) across the crash.
 */

const completed: AgentResult = {
  status: 'completed',
  summary: 'done',
  artifacts: {
    commit: 'abc',
    filesChanged: [],
    testsPassed: true,
    screenshotUrls: [],
    evidenceMarkers: [],
    prUrl: null,
    prNumber: null,
  },
  error: null,
};

const scoutResult: AgentResult = {
  ...completed,
  findings: { relevantFiles: [], patterns: [], constraints: [] } as never,
};

const verifierFail: AgentResult = {
  ...completed,
  rubric: {
    role: 'verifier',
    categories: [{ category: 'edge-case-checked', verdict: 'fail', detail: 'missing null check' }],
  },
};

/**
 * A stub run-state: the engine only needs a valid `getState()` for the
 * node-direct projection (empty phases/markers → no marker files, a single
 * no-op td write) plus the mutators it calls, which are no-ops here.
 */
function stubRunState() {
  return {
    getState: () => ({
      status: 'active',
      taskId: 'task-1',
      profile: 'standard',
      phases: new Map(),
      markers: new Set<string>(),
      pendingRevision: null,
    }),
    startPhase() {},
    endPhase() {},
    setStatus() {},
    requestRevision() {},
    end() {},
    seedRevision() {},
  };
}

/** Node-direct projection sink — the engine writes the td mirror here. */
const noopStore = { writeFromProjection: async () => {} };

const noopNotifier = {
  send() {},
  phaseStart() {},
  phaseEnd() {},
  toolStart() {},
  toolEnd() {},
  stepIndicator() {},
  startHeartbeat() {},
  stopHeartbeat() {},
  askUser: async (_p: string, options: string[]) => options[options.length - 1],
};

function baseArgs(runState: unknown, dispatch: DispatchFn, checkpointer: MemorySaver) {
  return {
    profile: 'standard' as const,
    maxRevisionCycles: 2,
    runState: runState as never,
    store: noopStore as never,
    caseRoot: '/tmp/case-resume-spec-unused',
    notifier: noopNotifier as never,
    dispatch,
    onPhaseFailed: () => {},
    checkpointer,
    threadId: 'task-1',
  };
}

describe('checkpointer resume parity', () => {
  it('resumes mid-implement_1 with the checkpointer-restored pending revision', async () => {
    const checkpointer = new MemorySaver();

    // --- Run 1: crash on the second implement (the revision cycle). ----------
    let implementCalls = 0;
    const crashDispatch: DispatchFn = async (node) => {
      switch (node.phase) {
        case 'scout':
          return scoutResult;
        case 'implement':
          implementCalls += 1;
          if (implementCalls === 2) throw new Error('simulated crash mid-implement_1');
          return completed;
        case 'verify':
          return verifierFail; // cycle 0 fails → revision requested → implement cycle 1
        default:
          return completed;
      }
    };

    await expect(executeLangGraph(baseArgs(stubRunState(), crashDispatch, checkpointer))).rejects.toThrow(
      'simulated crash mid-implement_1',
    );

    // --- Run 2: resume over the same checkpointer + thread. ------------------
    const resumeCalls: { phase: string; revision: RevisionRequest | null }[] = [];
    const resumeDispatch: DispatchFn = async (node, revision) => {
      resumeCalls.push({ phase: node.phase, revision: revision ?? null });
      return completed; // implement clears, verify passes, review/close/retro proceed
    };

    await executeLangGraph(baseArgs(stubRunState(), resumeDispatch, checkpointer));

    // It resumed at implement (no scout re-run) and ran the cycle to the end.
    expect(resumeCalls.map((c) => c.phase)).toEqual(['implement', 'verify', 'review', 'close', 'retrospective']);

    // The restored implement carried the pending revision from the pre-crash
    // verify failure (cycle 0 → cycle 1) — the checkpointer preserved it.
    const firstRevision = resumeCalls[0]?.revision;
    expect(firstRevision).not.toBeNull();
    expect(firstRevision?.source).toBe('verifier');
    expect(firstRevision?.cycle).toBe(1);
  });

  it('a clean run leaves no resumable checkpoint (thread dropped on completion)', async () => {
    const checkpointer = new MemorySaver();
    const cleanDispatch: DispatchFn = async () => completed;

    await executeLangGraph(baseArgs(stubRunState(), cleanDispatch, checkpointer));

    const tuple = await checkpointer.getTuple({ configurable: { thread_id: 'task-1', checkpoint_ns: '' } });
    expect(tuple).toBeUndefined();
  });
});
