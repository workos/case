import { describe, it, expect } from 'bun:test';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { executeLangGraph, type DispatchFn } from '../langgraph/engine.js';
import { reduceEvents } from '../events/reducer.js';
import type { AgentResult, RevisionRequest } from '../types.js';
import type { PipelineEvent } from '../events/types.js';

/**
 * Phase 1.2 acceptance — checkpointer resume parity (the new oracle that will
 * replace `events-reducer.spec` after the 1.3 cutover).
 *
 * A run is killed mid-`implement_1` (the implementer throws on the revision
 * cycle, escaping `invoke` exactly as a process crash would). A *second*
 * `executeLangGraph` over the SAME checkpointer + thread resumes. We assert the
 * restored run:
 *   1. re-enters at `implement` (not `scout`) — it did not restart from the top,
 *   2. carries the restored pending revision into that implement, and
 *   3. that restored revision matches what `reduceEvents` derives from the
 *      pre-crash event stream — i.e. the checkpointer snapshot and the legacy
 *      event-replay oracle agree on (revisionCycles, pendingRevision).
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

/** A recording appender: collects what the engine emits, stamped like the real one. */
function recordingAppender(events: PipelineEvent[]) {
  let seq = 1;
  return {
    // Minimal-but-valid PipelineState shape for the node-direct projection
    // (empty phases/markers → no marker files, a single no-op td write).
    getState: () => ({
      status: 'active',
      taskId: 'task-1',
      profile: 'standard',
      phases: new Map(),
      markers: new Set<string>(),
      pendingRevision: null,
    }),
    append: async (e: Record<string, unknown>) => {
      events.push({ ...e, ts: new Date(0).toISOString(), sequence: seq++ } as unknown as PipelineEvent);
    },
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

function baseArgs(appender: unknown, dispatch: DispatchFn, checkpointer: MemorySaver) {
  return {
    profile: 'standard' as const,
    maxRevisionCycles: 2,
    appender: appender as never,
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
  it('resumes mid-implement_1 with the restored pending revision (matches reduceEvents)', async () => {
    const checkpointer = new MemorySaver();

    // --- Run 1: crash on the second implement (the revision cycle). ----------
    const crashEvents: PipelineEvent[] = [];
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

    await expect(
      executeLangGraph(baseArgs(recordingAppender(crashEvents), crashDispatch, checkpointer)),
    ).rejects.toThrow('simulated crash mid-implement_1');

    // Legacy oracle: replay the pre-crash event stream the way resume used to.
    const oracleStream: PipelineEvent[] = [
      {
        event: 'pipeline_start',
        runId: 'r1',
        taskId: 'task-1',
        profile: 'standard',
        plan: {},
        ts: new Date(0).toISOString(),
        sequence: 0,
      } as unknown as PipelineEvent,
      ...crashEvents,
    ];
    const oracle = reduceEvents(oracleStream);
    expect(oracle.revisionCycles).toBe(1);
    expect(oracle.pendingRevision?.source).toBe('verifier');
    expect(oracle.pendingRevision?.cycle).toBe(1);

    // --- Run 2: resume over the same checkpointer + thread. ------------------
    const resumeCalls: { phase: string; revision: RevisionRequest | null }[] = [];
    const resumeDispatch: DispatchFn = async (node, revision) => {
      resumeCalls.push({ phase: node.phase, revision: revision ?? null });
      return completed; // implement clears, verify passes, review/close/retro proceed
    };

    await executeLangGraph(baseArgs(recordingAppender([]), resumeDispatch, checkpointer));

    // It resumed at implement (no scout re-run) and ran the cycle to the end.
    expect(resumeCalls.map((c) => c.phase)).toEqual(['implement', 'verify', 'review', 'close', 'retrospective']);

    // The restored implement carried the pending revision …
    const firstRevision = resumeCalls[0]?.revision;
    expect(firstRevision).not.toBeNull();
    expect(firstRevision?.source).toBe('verifier');
    expect(firstRevision?.cycle).toBe(1);

    // … and it agrees with the legacy event-replay oracle.
    expect(firstRevision?.source).toBe(oracle.pendingRevision?.source);
    expect(firstRevision?.cycle).toBe(oracle.pendingRevision?.cycle);
  });

  it('a clean run leaves no resumable checkpoint (thread dropped on completion)', async () => {
    const checkpointer = new MemorySaver();
    const cleanDispatch: DispatchFn = async () => completed;

    await executeLangGraph(baseArgs(recordingAppender([]), cleanDispatch, checkpointer));

    const tuple = await checkpointer.getTuple({ configurable: { thread_id: 'task-1', checkpoint_ns: '' } });
    expect(tuple).toBeUndefined();
  });
});
