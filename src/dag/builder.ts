import type { PipelineProfile } from '../types.js';
import { PROFILE_PHASES } from '../types.js';
import type { DagEdge, DagNode, NodeId, PipelineGraph } from './types.js';

export function buildGraph(profile: PipelineProfile, maxRevisionCycles: number): PipelineGraph {
  const nodes = new Map<NodeId, DagNode>();
  const edges: DagEdge[] = [];
  const phases = PROFILE_PHASES[profile];
  const hasVerify = phases.includes('verify');

  for (let cycle = 0; cycle <= maxRevisionCycles; cycle++) {
    const implId = nodeId('implement', cycle);
    nodes.set(implId, {
      id: implId,
      phase: 'implement',
      agent: 'implementer',
      cycle,
      state: 'pending',
    });

    if (hasVerify) {
      const verifyId = nodeId('verify', cycle);
      nodes.set(verifyId, {
        id: verifyId,
        phase: 'verify',
        agent: 'verifier',
        cycle,
        state: 'pending',
      });
      edges.push({
        from: implId,
        to: verifyId,
      });
    }

    const reviewId = nodeId('review', cycle);
    nodes.set(reviewId, {
      id: reviewId,
      phase: 'review',
      agent: 'reviewer',
      cycle,
      state: 'pending',
    });

    if (hasVerify) {
      edges.push({
        from: nodeId('verify', cycle),
        to: reviewId,
        predicate: verifyPassedPredicate(cycle),
      });
    } else {
      edges.push({
        from: implId,
        to: reviewId,
      });
    }

    // Wire revision edges: evaluators at cycle N → implement at cycle N+1
    if (cycle < maxRevisionCycles) {
      const nextImplId = nodeId('implement', cycle + 1);
      if (hasVerify) {
        edges.push({
          from: nodeId('verify', cycle),
          to: nextImplId,
          predicate: revisionRequestedPredicate(cycle, hasVerify),
        });
      }
      edges.push({
        from: nodeId('review', cycle),
        to: nextImplId,
        predicate: revisionRequestedPredicate(cycle, hasVerify),
      });
    }
  }

  // Evaluator completion edges → close directly.
  for (let cycle = 0; cycle <= maxRevisionCycles; cycle++) {
    const evaluatorIds = hasVerify ? [nodeId('verify', cycle), nodeId('review', cycle)] : [nodeId('review', cycle)];
    for (const evalId of evaluatorIds) {
      edges.push({
        from: evalId,
        to: 'close',
        predicate: noRevisionPredicate(cycle, hasVerify),
      });
    }
  }

  // Close + retrospective
  nodes.set('close', {
    id: 'close',
    phase: 'close',
    agent: 'closer',
    cycle: 0,
    state: 'pending',
  });

  nodes.set('retrospective', {
    id: 'retrospective',
    phase: 'retrospective',
    agent: 'retrospective',
    cycle: 0,
    state: 'pending',
  });

  edges.push({ from: 'close', to: 'retrospective' });

  validateGraph(nodes, edges);

  return { nodes, edges };
}

export function nodeId(phase: string, cycle: number): NodeId {
  return `${phase}_${cycle}`;
}

function verifyPassedPredicate(cycle: number) {
  return (graph: PipelineGraph): boolean => {
    const verifyNode = graph.nodes.get(nodeId('verify', cycle));
    if (!verifyNode || verifyNode.state !== 'completed') return false;
    if (hasRevisionResult(verifyNode)) {
      const nextImpl = graph.nodes.get(nodeId('implement', cycle + 1));
      return !nextImpl;
    }
    return true;
  };
}

function noRevisionPredicate(cycle: number, hasVerify: boolean) {
  return (graph: PipelineGraph): boolean => {
    const reviewNode = graph.nodes.get(nodeId('review', cycle));
    if (!reviewNode || reviewNode.state !== 'completed') return false;

    if (hasVerify) {
      const verifyNode = graph.nodes.get(nodeId('verify', cycle));
      if (!verifyNode || verifyNode.state !== 'completed') return false;
    }

    // Check that no evaluator at this cycle has a failed rubric
    const evaluators = hasVerify
      ? [graph.nodes.get(nodeId('verify', cycle))!, graph.nodes.get(nodeId('review', cycle))!]
      : [graph.nodes.get(nodeId('review', cycle))!];

    if (evaluators.some((node) => hasRevisionResult(node))) {
      // A revision was requested — don't proceed to close.
      const nextImpl = graph.nodes.get(nodeId('implement', cycle + 1));
      if (nextImpl) return false;
      // No next implement means budget exhausted — allow proceeding
    }

    return true;
  };
}

function revisionRequestedPredicate(cycle: number, hasVerify: boolean) {
  return (graph: PipelineGraph): boolean => {
    if (hasVerify) {
      const verifyNode = graph.nodes.get(nodeId('verify', cycle));
      if (!verifyNode || verifyNode.state !== 'completed') return false;
      if (hasRevisionResult(verifyNode)) return true;
    }

    const reviewNode = graph.nodes.get(nodeId('review', cycle));
    if (!reviewNode || reviewNode.state !== 'completed') return false;
    return hasRevisionResult(reviewNode);
  };
}

function hasRevisionResult(node: DagNode): boolean {
  if (!node.result) return false;
  if (node.result.rubric) {
    return node.result.rubric.categories.some((c) => c.verdict === 'fail');
  }
  return false;
}

function validateGraph(nodes: Map<NodeId, DagNode>, edges: DagEdge[]): void {
  // Verify all edge endpoints exist
  for (const edge of edges) {
    if (!nodes.has(edge.from)) throw new Error(`Edge references missing source node: ${edge.from}`);
    if (!nodes.has(edge.to)) throw new Error(`Edge references missing target node: ${edge.to}`);
  }

  // Simple cycle detection via topological sort attempt
  const inDegree = new Map<NodeId, number>();
  for (const id of nodes.keys()) inDegree.set(id, 0);
  // Only count unconditional edges for cycle detection (predicated edges may not fire)
  const unconditionalEdges = edges.filter((e) => !e.predicate);
  for (const edge of unconditionalEdges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited++;
    for (const edge of unconditionalEdges) {
      if (edge.from === id) {
        const remaining = (inDegree.get(edge.to) ?? 1) - 1;
        inDegree.set(edge.to, remaining);
        if (remaining === 0) queue.push(edge.to);
      }
    }
  }
  if (visited < nodes.size) {
    throw new Error('Cycle detected in pipeline graph');
  }
}
