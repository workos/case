import type { PipelineState } from '../events/types.js';
import type { PipelineGraph } from './types.js';

export function restoreGraphState(graph: PipelineGraph, state: PipelineState): void {
  for (const [key, phaseState] of state.phases) {
    // Phase keys in PipelineState use the same format as graph node IDs: "phase_cycle"
    const node = graph.nodes.get(key);
    if (!node) {
      // Try terminal nodes (close, retrospective) that don't have cycle suffixes.
      const terminalNode = graph.nodes.get(phaseState.phase);
      if (terminalNode) {
        applyPhaseState(terminalNode, phaseState);
      }
      continue;
    }
    applyPhaseState(node, phaseState);
  }
}

function applyPhaseState(
  node: import('./types.js').DagNode,
  phaseState: import('../events/types.js').PhaseState,
): void {
  switch (phaseState.status) {
    case 'completed':
      node.state = 'completed';
      node.startedAt = phaseState.startedAt;
      node.completedAt = phaseState.completedAt;
      if (phaseState.result) node.result = phaseState.result;
      break;
    case 'failed':
      node.state = 'failed';
      node.startedAt = phaseState.startedAt;
      node.completedAt = phaseState.completedAt;
      if (phaseState.result) node.result = phaseState.result;
      break;
    case 'skipped':
      node.state = 'skipped';
      break;
    case 'running':
      node.state = 'pending';
      break;
  }
}
