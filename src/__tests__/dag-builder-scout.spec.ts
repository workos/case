import { describe, test, expect } from 'bun:test';
import { buildGraph, nodeId } from '../dag/builder.js';

describe('buildGraph — scout integration', () => {
  describe('standard profile', () => {
    const graph = buildGraph('standard', 2);

    test('scout_0 node exists and is the only root', () => {
      expect(graph.nodes.has('scout_0')).toBe(true);
      const scoutNode = graph.nodes.get('scout_0')!;
      expect(scoutNode.phase).toBe('scout');
      expect(scoutNode.agent).toBe('scout');
      expect(scoutNode.cycle).toBe(0);
      expect(scoutNode.state).toBe('pending');

      // Scout has no incoming edges — it is the new root.
      const incoming = graph.edges.filter((e) => e.to === 'scout_0');
      expect(incoming).toHaveLength(0);
    });

    test('scout_0 has an unconditional edge to implement_0', () => {
      const edge = graph.edges.find((e) => e.from === 'scout_0' && e.to === 'implement_0');
      expect(edge).toBeDefined();
      expect(edge!.predicate).toBeUndefined();
    });

    test('scout is added at cycle 0 only (no scout_1, scout_2)', () => {
      expect(graph.nodes.has('scout_1')).toBe(false);
      expect(graph.nodes.has('scout_2')).toBe(false);
    });

    test('revision cycles still wire correctly with scout present', () => {
      // verify_0 → implement_1 (revision) — predicate guards
      const toImpl1 = graph.edges.filter((e) => e.to === 'implement_1');
      expect(toImpl1.length).toBeGreaterThanOrEqual(2);
      expect(toImpl1.every((e) => e.predicate !== undefined)).toBe(true);
    });
  });

  describe('tiny profile', () => {
    const graph = buildGraph('tiny', 2);

    test('does NOT include a scout node', () => {
      expect(graph.nodes.has('scout_0')).toBe(false);
      for (const [id] of graph.nodes) {
        expect(id.startsWith('scout_')).toBe(false);
      }
    });

    test('implement_0 is the root', () => {
      const incoming = graph.edges.filter((e) => e.to === 'implement_0');
      expect(incoming).toHaveLength(0);
    });
  });

  describe('zero revision cycles', () => {
    const graph = buildGraph('standard', 0);

    test('scout still added before implement_0', () => {
      expect(graph.nodes.has('scout_0')).toBe(true);
      const edge = graph.edges.find((e) => e.from === 'scout_0' && e.to === 'implement_0');
      expect(edge).toBeDefined();
    });
  });

  describe('cycle detection', () => {
    test('graph with scout passes topological sort', () => {
      expect(() => buildGraph('standard', 2)).not.toThrow();
      expect(() => buildGraph('standard', 0)).not.toThrow();
      expect(() => buildGraph('standard', 5)).not.toThrow();
    });
  });

  describe('nodeId helper continues to work for scout', () => {
    test('scout_0 follows the same naming convention', () => {
      expect(nodeId('scout', 0)).toBe('scout_0');
    });
  });
});
