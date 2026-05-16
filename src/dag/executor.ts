import type { AgentResult, PipelineConfig, RevisionRequest } from '../types.js';
import type { EventAppender } from '../events/appender.js';
import type { Notifier } from '../notify.js';
import type { DagNode, PipelineGraph } from './types.js';
import { nodeId } from './builder.js';
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

    for (const node of readyNodes) {
      await appender.append({ event: 'phase_start', phase: node.phase, agent: node.agent });
      ctx.notifier.phaseStart(node.phase, node.agent);
    }

    await emitStatusChange(ctx);

    const results = await Promise.all(
      readyNodes.map(async (node) => {
        const pendingRevision = getPendingRevisionForNode(node, revisionRequests);
        const result = await ctx.dispatchPhase(node, pendingRevision);
        return { node, result };
      }),
    );

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
    await handleEvaluatorPairCompletion(ctx, revisionRequests);

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
        const result = await ctx.dispatchPhase(retro);
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
      if (!nextImplNode) {
        revisionRequests.set(cycle, []);
        const sources = [...new Set(requests.map((r) => r.source))].join(', ');
        await appender.append({
          event: 'revision_budget_exhausted',
          cycles: cycle + 1,
        });
        ctx.notifier.send(
          `Revision budget exhausted after cycle ${cycle}. ${sources} found issues but no revision cycles remain. Proceeding with warnings.`,
        );
      } else {
        revisionRequests.set(cycle, requests);
        const merged = mergeRevisionRequests(requests);
        const sources = [...new Set(requests.map((r) => r.source))].join(', ');
        await appender.append({
          event: 'revision_requested',
          source: merged.source,
          cycle: cycle + 1,
          failedCategories: merged.failedCategories,
        });
        ctx.notifier.send(`Revision cycle ${cycle + 1}: ${sources} found fixable issues, re-implementing`);
      }
    } else {
      revisionRequests.set(cycle, []);
    }
  }
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
