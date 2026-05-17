import { describe, test, expect } from 'bun:test';
import { projectStatusFromGraph } from '../dag/status.js';
import { buildGraph } from '../dag/builder.js';
import type { PipelineGraph, DagNode } from '../dag/types.js';

function setNodeState(graph: PipelineGraph, nodeId: string, state: DagNode['state']) {
  const node = graph.nodes.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  node.state = state;
}

describe('projectStatusFromGraph', () => {
  test('returns active when no nodes are running and first node is pending', () => {
    const graph = buildGraph('standard', 2);
    expect(projectStatusFromGraph(graph)).toBe('active');
  });

  test('returns implementing when implement_0 is running', () => {
    const graph = buildGraph('standard', 2);
    setNodeState(graph, 'implement_0', 'running');
    expect(projectStatusFromGraph(graph)).toBe('implementing');
  });

  test('returns verifying when only verify_0 is running', () => {
    const graph = buildGraph('standard', 2);
    setNodeState(graph, 'implement_0', 'completed');
    setNodeState(graph, 'verify_0', 'running');
    expect(projectStatusFromGraph(graph)).toBe('verifying');
  });

  test('returns reviewing when only review_0 is running', () => {
    const graph = buildGraph('standard', 2);
    setNodeState(graph, 'implement_0', 'completed');
    setNodeState(graph, 'review_0', 'running');
    expect(projectStatusFromGraph(graph)).toBe('reviewing');
  });

  test('returns evaluating when both verify_0 and review_0 are running', () => {
    const graph = buildGraph('standard', 2);
    setNodeState(graph, 'implement_0', 'completed');
    setNodeState(graph, 'verify_0', 'running');
    setNodeState(graph, 'review_0', 'running');
    expect(projectStatusFromGraph(graph)).toBe('evaluating');
  });

  test('returns evaluating when both evaluators complete and close is pending', () => {
    const graph = buildGraph('standard', 2);
    setNodeState(graph, 'implement_0', 'completed');
    setNodeState(graph, 'verify_0', 'completed');
    setNodeState(graph, 'review_0', 'completed');
    expect(projectStatusFromGraph(graph)).toBe('evaluating');
  });

  test('returns closing when close is running', () => {
    const graph = buildGraph('standard', 2);
    setNodeState(graph, 'implement_0', 'completed');
    setNodeState(graph, 'verify_0', 'completed');
    setNodeState(graph, 'review_0', 'completed');
    setNodeState(graph, 'close', 'running');
    expect(projectStatusFromGraph(graph)).toBe('closing');
  });

  test('returns pr-opened when close is completed but retrospective is pending', () => {
    const graph = buildGraph('standard', 2);
    setNodeState(graph, 'implement_0', 'completed');
    setNodeState(graph, 'verify_0', 'completed');
    setNodeState(graph, 'review_0', 'completed');
    setNodeState(graph, 'close', 'completed');
    // skip unused revision nodes
    for (let c = 1; c <= 2; c++) {
      setNodeState(graph, `implement_${c}`, 'skipped');
      setNodeState(graph, `verify_${c}`, 'skipped');
      setNodeState(graph, `review_${c}`, 'skipped');
    }
    expect(projectStatusFromGraph(graph)).toBe('pr-opened');
  });

  test('returns merged when all nodes are completed/skipped', () => {
    const graph = buildGraph('standard', 2);
    setNodeState(graph, 'implement_0', 'completed');
    setNodeState(graph, 'verify_0', 'completed');
    setNodeState(graph, 'review_0', 'completed');
    setNodeState(graph, 'close', 'completed');
    setNodeState(graph, 'retrospective', 'completed');
    for (let c = 1; c <= 2; c++) {
      setNodeState(graph, `implement_${c}`, 'skipped');
      setNodeState(graph, `verify_${c}`, 'skipped');
      setNodeState(graph, `review_${c}`, 'skipped');
    }
    expect(projectStatusFromGraph(graph)).toBe('merged');
  });

  test('tiny profile: review_0 completed marks evaluating (no verify)', () => {
    const graph = buildGraph('tiny', 2);
    setNodeState(graph, 'implement_0', 'completed');
    setNodeState(graph, 'review_0', 'completed');
    expect(projectStatusFromGraph(graph)).toBe('evaluating');
  });
});
