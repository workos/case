import type { TaskStatus } from '../types.js';
import type { PipelineGraph } from './types.js';

export function projectStatusFromGraph(graph: PipelineGraph): TaskStatus {
  const running: string[] = [];
  const runningPhases = new Set<string>();

  for (const [, node] of graph.nodes) {
    if (node.state === 'running') {
      running.push(node.id);
      runningPhases.add(node.phase);
    }
  }

  // Both verify and review running concurrently
  if (runningPhases.has('verify') && runningPhases.has('review')) return 'evaluating';

  // Single running node
  if (running.length > 0) {
    const node = graph.nodes.get(running[0])!;
    switch (node.phase) {
      case 'implement':
        return 'implementing';
      case 'verify':
        return 'verifying';
      case 'review':
        return 'reviewing';
      case 'approve':
        return 'approving';
      case 'close':
        return 'closing';
    }
  }

  // Both evaluators completed, close not yet started
  const hasCompletedEvaluatorPair = findCompletedEvaluatorPair(graph);
  if (hasCompletedEvaluatorPair) {
    const closeNode = graph.nodes.get('close');
    if (closeNode && closeNode.state === 'pending') return 'evaluating';
  }

  // Close completed
  const closeNode = graph.nodes.get('close');
  if (closeNode?.state === 'completed') {
    // Check if all nodes are done
    let allDone = true;
    for (const [, node] of graph.nodes) {
      if (node.state !== 'completed' && node.state !== 'skipped') {
        allDone = false;
        break;
      }
    }
    if (allDone) return 'merged';
    return 'pr-opened';
  }

  return 'active';
}

function findCompletedEvaluatorPair(graph: PipelineGraph): boolean {
  for (const [, node] of graph.nodes) {
    if (node.phase === 'verify' && node.state === 'completed') {
      const reviewNode = findMatchingReview(graph, node.cycle);
      if (reviewNode?.state === 'completed') return true;
    }
    if (node.phase === 'review' && node.state === 'completed') {
      // For tiny profile with no verify, check if close is pending
      const verifyNode = findMatchingVerify(graph, node.cycle);
      if (!verifyNode) {
        // No verify in this graph — review alone is the evaluator pair
        return true;
      }
    }
  }
  return false;
}

function findMatchingReview(graph: PipelineGraph, cycle: number) {
  return graph.nodes.get(`review_${cycle}`);
}

function findMatchingVerify(graph: PipelineGraph, cycle: number) {
  return graph.nodes.get(`verify_${cycle}`);
}
