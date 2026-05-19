import type { AgentResult, PipelineConfig, RevisionRequest } from '../types.js';
import type { EventAppender } from '../events/appender.js';
import type { Notifier } from '../notify.js';
import type { DagNode, PipelineGraph } from './types.js';
import { nodeId } from './builder.js';
import { computeFingerprint, fingerprintsMatch } from './fingerprint.js';
import { mergeRevisionRequests } from './merge.js';
import { projectStatusFromGraph } from './status.js';

export interface ExecuteGraphContext {
  graph: PipelineGraph;
  appender: EventAppender;
  config: PipelineConfig;
  notifier: Notifier;
  dispatchPhase: (node: DagNode, revision?: RevisionRequest) => Promise<AgentResult>;
  initialRevisionRequests?: Map<number, RevisionRequest[]>;
}

export async function executeGraph(ctx: ExecuteGraphContext): Promise<void> {
  const { graph, appender } = ctx;
  const revisionRequests = new Map<number, RevisionRequest[]>(ctx.initialRevisionRequests ?? []);
  /**
   * Per-cycle failure fingerprints. Keyed by the cycle that produced the
   * fingerprint (0-indexed). Comparing the new cycle's fingerprint to the
   * previous one's lets the executor abort early when the same failure
   * signature repeats.
   */
  const cycleFingerprints = new Map<number, string>();

  while (true) {
    const readyNodes = findReadyNodes(graph);

    if (readyNodes.length === 0) {
      const hasRunning = [...graph.nodes.values()].some((n) => n.state === 'running');
      if (!hasRunning) break;
      // Shouldn't happen — readyNodes empty while nodes are running means we're waiting
      // but all running nodes should resolve via Promise.all below
      break;
    }

    for (const node of readyNodes) {
      node.state = 'ready';
    }

    for (const node of readyNodes) {
      node.state = 'running';
      node.startedAt = new Date().toISOString();
    }

    // Step indicator: visible phases derived from the current cycle's ready nodes,
    // not the full graph (revision cycles would inflate the count).
    emitStepIndicator(ctx, readyNodes);

    for (const node of readyNodes) {
      await appender.append({ event: 'phase_start', phase: node.phase, agent: node.agent });
      ctx.notifier.phaseStart(node.phase, node.agent);
    }

    await emitStatusChange(ctx);

    ctx.notifier.startHeartbeat();
    let results: Array<{ node: DagNode; result: AgentResult }>;
    try {
      results = await Promise.all(
        readyNodes.map(async (node) => {
          const pendingRevision = getPendingRevisionForNode(node, revisionRequests);
          const result = await ctx.dispatchPhase(node, pendingRevision);
          return { node, result };
        }),
      );
    } finally {
      ctx.notifier.stopHeartbeat();
    }

    for (const { node, result } of results) {
      const elapsed = Date.now() - Date.parse(node.startedAt!);
      node.result = result;

      if (result.status === 'completed') {
        node.state = 'completed';
        node.completedAt = new Date().toISOString();

        await appender.append({
          event: 'phase_end',
          phase: node.phase,
          agent: node.agent,
          outcome: 'completed',
          durationMs: elapsed,
          result,
        });
        ctx.notifier.phaseEnd(node.phase, node.agent, elapsed, 'completed');
      } else {
        node.state = 'failed';
        node.completedAt = new Date().toISOString();

        await appender.append({
          event: 'phase_end',
          phase: node.phase,
          agent: node.agent,
          outcome: 'failed',
          durationMs: elapsed,
          result,
        });
        ctx.notifier.phaseEnd(node.phase, node.agent, elapsed, 'failed');
      }
    }

    // After evaluator pair completes at a given cycle, handle revision detection
    await handleEvaluatorPairCompletion(ctx, revisionRequests, cycleFingerprints);

    // If any node failed, skip to retrospective
    const hasFailed = [...graph.nodes.values()].some((n) => n.state === 'failed');
    if (hasFailed) {
      // Skip all pending nodes except retrospective
      for (const [, node] of graph.nodes) {
        if (node.state === 'pending' && node.id !== 'retrospective') {
          node.state = 'skipped';
          await appender.append({
            event: 'phase_end',
            phase: node.phase,
            agent: node.agent,
            outcome: 'skipped',
            durationMs: 0,
          });
        }
      }
      // Force retrospective to ready
      const retro = graph.nodes.get('retrospective');
      if (retro && retro.state === 'pending') {
        retro.state = 'ready';
        retro.startedAt = new Date().toISOString();
        retro.state = 'running';
        await appender.append({ event: 'phase_start', phase: 'retrospective', agent: 'retrospective' });
        ctx.notifier.phaseStart('retrospective', 'retrospective');
        ctx.notifier.startHeartbeat();
        let result: AgentResult;
        try {
          result = await ctx.dispatchPhase(retro);
        } finally {
          ctx.notifier.stopHeartbeat();
        }
        const elapsed = Date.now() - Date.parse(retro.startedAt!);
        retro.result = result;
        retro.state = 'completed';
        retro.completedAt = new Date().toISOString();
        await appender.append({
          event: 'phase_end',
          phase: 'retrospective',
          agent: 'retrospective',
          outcome: 'completed',
          durationMs: elapsed,
          result,
        });
        ctx.notifier.phaseEnd('retrospective', 'retrospective', elapsed, 'completed');
      }
      break;
    }

    await emitStatusChange(ctx);
  }

  // Skip all remaining pending nodes
  for (const [, node] of graph.nodes) {
    if (node.state === 'pending') {
      node.state = 'skipped';
      await appender.append({
        event: 'phase_end',
        phase: node.phase,
        agent: node.agent,
        outcome: 'skipped',
        durationMs: 0,
      });
    }
  }
}

export function findReadyNodes(graph: PipelineGraph): DagNode[] {
  const ready: DagNode[] = [];

  for (const [, node] of graph.nodes) {
    if (node.state !== 'pending') continue;

    const incomingEdges = graph.edges.filter((e) => e.to === node.id);

    if (incomingEdges.length === 0) {
      // Root nodes are always ready if pending
      ready.push(node);
      continue;
    }

    // A node is ready if at least one incoming edge has:
    // 1. Source node completed/skipped
    // 2. Predicate satisfied (or no predicate)
    const anySatisfied = incomingEdges.some((edge) => {
      const source = graph.nodes.get(edge.from);
      if (!source) return false;
      if (source.state !== 'completed' && source.state !== 'skipped') return false;
      if (edge.predicate && !edge.predicate(graph)) return false;
      return true;
    });

    if (anySatisfied) {
      ready.push(node);
    }
  }

  return ready;
}

function getPendingRevisionForNode(
  node: DagNode,
  revisionRequests: Map<number, RevisionRequest[]>,
): RevisionRequest | undefined {
  if (node.phase !== 'implement' || node.cycle === 0) return undefined;
  const requests = revisionRequests.get(node.cycle - 1);
  if (!requests || requests.length === 0) return undefined;
  return mergeRevisionRequests(requests);
}

async function handleEvaluatorPairCompletion(
  ctx: ExecuteGraphContext,
  revisionRequests: Map<number, RevisionRequest[]>,
  cycleFingerprints: Map<number, string>,
): Promise<void> {
  const { graph, appender } = ctx;

  for (const [, node] of graph.nodes) {
    if (node.phase !== 'verify' && node.phase !== 'review') continue;
    if (node.state !== 'completed') continue;

    const cycle = node.cycle;
    if (revisionRequests.has(cycle)) continue;

    const verifyNode = graph.nodes.get(nodeId('verify', cycle));
    const reviewNode = graph.nodes.get(nodeId('review', cycle));

    // Collect revision requests from completed evaluators
    const requests: RevisionRequest[] = [];
    for (const evalNode of [verifyNode, reviewNode].filter(Boolean) as DagNode[]) {
      if (evalNode.state !== 'completed') continue;
      const revision = extractRevisionFromResult(evalNode, cycle);
      if (revision) requests.push(revision);
    }

    // If verify found issues, act immediately (don't wait for review)
    if (requests.length === 0) {
      // Both must be complete for "no revision" conclusion
      if (verifyNode && verifyNode.state !== 'completed') continue;
      if (reviewNode && reviewNode.state !== 'completed') continue;
    }

    if (requests.length > 0) {
      const nextImplNode = graph.nodes.get(nodeId('implement', cycle + 1));

      // Compute the fingerprint for this cycle's failure signature so we can
      // (a) compare against the previous cycle for early-abort and
      // (b) attach it to the merged RevisionRequest for downstream consumers.
      const fingerprint = computeFingerprintFromRequests(requests);

      if (!nextImplNode) {
        revisionRequests.set(cycle, []);
        if (fingerprint) cycleFingerprints.set(cycle, fingerprint);
        const sources = [...new Set(requests.map((r) => r.source))].join(', ');
        await appender.append({
          event: 'revision_budget_exhausted',
          cycles: cycle + 1,
        });
        ctx.notifier.send(
          `Revision budget exhausted after cycle ${cycle}. ${sources} found issues but no revision cycles remain. Proceeding with warnings.`,
        );
        continue;
      }

      // Compare to previous cycle's fingerprint. If they match, the same
      // failure already came back once — burning another implementer cycle
      // is statistically unlikely to help, so route through the
      // budget-exhausted path.
      const previousCycle = cycle - 1;
      const previousFingerprint = previousCycle >= 0 ? cycleFingerprints.get(previousCycle) : undefined;
      if (fingerprint && previousFingerprint && fingerprintsMatch(fingerprint, previousFingerprint)) {
        cycleFingerprints.set(cycle, fingerprint);
        revisionRequests.set(cycle, []);

        // Actively skip the next revision cycle's nodes so the DAG's
        // predicate-driven dispatch doesn't run them anyway. The graph
        // wires `verify_N → implement_{N+1}` via `revisionRequestedPredicate`
        // which only inspects rubric verdicts — without this skip step,
        // implement_{N+1} would fire despite the fingerprint match.
        await skipRevisionTail(ctx, cycle + 1);

        await appender.append({
          event: 'fingerprint_match',
          cycle: cycle + 1,
          fingerprint,
          previousCycle,
        });
        await appender.append({
          event: 'revision_budget_exhausted',
          cycles: cycle + 1,
        });
        ctx.notifier.send(
          `Revision budget exhausted: fingerprint match (cycle ${cycle} matched cycle ${previousCycle}, ${fingerprint}). Aborting revision cycle ${cycle + 1} and proceeding with warnings.`,
        );
        continue;
      }

      if (fingerprint) cycleFingerprints.set(cycle, fingerprint);
      const merged = mergeRevisionRequests(requests);
      if (fingerprint) merged.fingerprint = fingerprint;
      // Replace the stored requests with fingerprint-annotated copies so
      // downstream readers (`getPendingRevisionForNode`) see the merged value.
      revisionRequests.set(
        cycle,
        requests.map((r) => (fingerprint ? { ...r, fingerprint } : r)),
      );
      const sources = [...new Set(requests.map((r) => r.source))].join(', ');
      await appender.append({
        event: 'revision_requested',
        source: merged.source,
        cycle: cycle + 1,
        failedCategories: merged.failedCategories,
      });
      ctx.notifier.send(`Revision cycle ${cycle + 1}: ${sources} found fixable issues, re-implementing`);
    } else {
      revisionRequests.set(cycle, []);
    }
  }
}

/**
 * Mark every revision-cycle node from `startCycle` onward (implement/verify/
 * review) as `skipped` and emit a corresponding `phase_end` event. Used by the
 * fingerprint-match early-abort path to prevent the predicate-driven DAG from
 * dispatching another cycle after we've already decided the failure repeats.
 *
 * Idempotent — nodes that are not pending are left alone.
 */
async function skipRevisionTail(ctx: ExecuteGraphContext, startCycle: number): Promise<void> {
  const { graph, appender } = ctx;
  for (const [, node] of graph.nodes) {
    if (node.phase !== 'implement' && node.phase !== 'verify' && node.phase !== 'review') continue;
    if (node.cycle < startCycle) continue;
    if (node.state !== 'pending') continue;
    node.state = 'skipped';
    await appender.append({
      event: 'phase_end',
      phase: node.phase,
      agent: node.agent,
      outcome: 'skipped',
      durationMs: 0,
    });
  }
}

/**
 * Derive a fingerprint from a cycle's revision requests. Returns `undefined`
 * when there are no failed categories to hash — guards against false matches
 * on empty inputs (see Failure Modes in spec-phase-2.md).
 */
function computeFingerprintFromRequests(requests: RevisionRequest[]): string | undefined {
  const failedCategories: string[] = [];
  const summaries: string[] = [];
  for (const r of requests) {
    for (const c of r.failedCategories) {
      failedCategories.push(c.category);
    }
    if (r.summary) summaries.push(r.summary);
  }
  if (failedCategories.length === 0) return undefined;
  return computeFingerprint({
    failedCategories,
    errorSummary: summaries.join('\n'),
  });
}

function extractRevisionFromResult(node: DagNode, cycle: number): RevisionRequest | null {
  if (!node.result?.rubric) return null;
  const failedCategories = node.result.rubric.categories.filter((c) => c.verdict === 'fail');
  if (failedCategories.length === 0) return null;

  const source = node.phase === 'verify' ? 'verifier' : 'reviewer';
  return {
    source: source as 'verifier' | 'reviewer',
    failedCategories,
    summary: node.result.summary,
    suggestedFocus: node.result.artifacts?.filesChanged ?? [],
    cycle: cycle + 1,
  };
}

async function emitStatusChange(ctx: ExecuteGraphContext): Promise<void> {
  const status = projectStatusFromGraph(ctx.graph);
  const currentStatus = ctx.appender.getState().status;
  if (currentStatus !== status) {
    await ctx.appender.append({ event: 'status_changed', from: currentStatus, to: status });
  }
}

/**
 * Emit a step indicator for the visible (current-cycle) phases.
 * Revision cycles create extra implement_N/verify_N/review_N nodes — we collapse
 * them so the user sees a stable "5 phase" pipeline regardless of how many
 * revision rounds happen.
 */
function emitStepIndicator(ctx: ExecuteGraphContext, readyNodes: DagNode[]): void {
  const phases = visiblePhases(ctx.graph);
  if (phases.length === 0) return;

  // Active phase = the first ready node's phase (or whichever is first by index).
  const activePhase = readyNodes[0]?.phase ?? null;
  const activeIdx = activePhase ? phases.indexOf(activePhase) : -1;
  if (activeIdx < 0) return;

  const completed = phases.slice(0, activeIdx);
  const pending = phases.slice(activeIdx + 1);
  ctx.notifier.stepIndicator(completed, activePhase!, pending);
}

/**
 * Distinct ordered phase names from the graph (collapses cycle suffixes).
 * Falls back to insertion order from graph.nodes.
 */
function visiblePhases(graph: import('./types.js').PipelineGraph): string[] {
  const seen: string[] = [];
  for (const [, node] of graph.nodes) {
    if (!seen.includes(node.phase)) seen.push(node.phase);
  }
  return seen;
}
