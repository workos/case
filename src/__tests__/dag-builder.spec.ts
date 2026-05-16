import { describe, test, expect } from 'bun:test';
import { buildGraph, nodeId } from '../dag/builder.js';

describe('buildGraph', () => {
  describe('standard profile', () => {
    const graph = buildGraph('standard', 2);

    test('has implement_0, verify_0, review_0, close, retrospective as base nodes', () => {
      expect(graph.nodes.has('implement_0')).toBe(true);
      expect(graph.nodes.has('verify_0')).toBe(true);
      expect(graph.nodes.has('review_0')).toBe(true);
      expect(graph.nodes.has('close')).toBe(true);
      expect(graph.nodes.has('retrospective')).toBe(true);
    });

    test('has revision nodes up to maxRevisionCycles', () => {
      expect(graph.nodes.has('implement_1')).toBe(true);
      expect(graph.nodes.has('verify_1')).toBe(true);
      expect(graph.nodes.has('review_1')).toBe(true);
      expect(graph.nodes.has('implement_2')).toBe(true);
      expect(graph.nodes.has('verify_2')).toBe(true);
      expect(graph.nodes.has('review_2')).toBe(true);
    });

    test('total node count matches: 3 per cycle * 3 cycles + close + retrospective', () => {
      // 3 nodes per cycle (impl, verify, review) * 3 cycles + close + retro = 11
      expect(graph.nodes.size).toBe(11);
    });

    test('all nodes start as pending', () => {
      for (const [, node] of graph.nodes) {
        expect(node.state).toBe('pending');
      }
    });

    test('implement_0 has edge to verify_0, verify_0 has edge to review_0', () => {
      const implEdges = graph.edges.filter((e) => e.from === 'implement_0');
      const implTargets = implEdges.map((e) => e.to);
      expect(implTargets).toContain('verify_0');
      expect(implTargets).not.toContain('review_0');

      const verifyEdges = graph.edges.filter((e) => e.from === 'verify_0' && e.to === 'review_0');
      expect(verifyEdges.length).toBe(1);
      expect(verifyEdges[0].predicate).toBeDefined();
    });

    test('verify_0 and review_0 have predicated edges to close', () => {
      const toClose = graph.edges.filter((e) => e.to === 'close');
      const fromVerify0 = toClose.find((e) => e.from === 'verify_0');
      const fromReview0 = toClose.find((e) => e.from === 'review_0');
      expect(fromVerify0).toBeDefined();
      expect(fromReview0).toBeDefined();
      expect(fromVerify0!.predicate).toBeDefined();
      expect(fromReview0!.predicate).toBeDefined();
    });

    test('evaluators have predicated edges to implement_1 for revision', () => {
      const toImpl1 = graph.edges.filter((e) => e.to === 'implement_1');
      expect(toImpl1.length).toBe(2); // verify_0 → impl_1, review_0 → impl_1
      expect(toImpl1.every((e) => e.predicate !== undefined)).toBe(true);
    });

    test('close has unconditional edge to retrospective', () => {
      const closeToRetro = graph.edges.find((e) => e.from === 'close' && e.to === 'retrospective');
      expect(closeToRetro).toBeDefined();
      expect(closeToRetro!.predicate).toBeUndefined();
    });

    test('cycle field is set correctly on nodes', () => {
      expect(graph.nodes.get('implement_0')!.cycle).toBe(0);
      expect(graph.nodes.get('verify_1')!.cycle).toBe(1);
      expect(graph.nodes.get('review_2')!.cycle).toBe(2);
    });
  });

  describe('tiny profile', () => {
    const graph = buildGraph('tiny', 2);

    test('has no verify nodes', () => {
      for (const [id] of graph.nodes) {
        expect(id.startsWith('verify_')).toBe(false);
      }
    });

    test('has implement and review nodes', () => {
      expect(graph.nodes.has('implement_0')).toBe(true);
      expect(graph.nodes.has('review_0')).toBe(true);
    });

    test('implement_0 has edge directly to review_0', () => {
      const implToReview = graph.edges.find((e) => e.from === 'implement_0' && e.to === 'review_0');
      expect(implToReview).toBeDefined();
    });

    test('total node count: 2 per cycle * 3 cycles + close + retro = 8', () => {
      expect(graph.nodes.size).toBe(8);
    });
  });

  describe('with approve option', () => {
    const graph = buildGraph('standard', 1, { approve: true });

    test('has approve node', () => {
      expect(graph.nodes.has('approve')).toBe(true);
    });

    test('evaluators have edges to approve (not directly to close)', () => {
      const toApprove = graph.edges.filter((e) => e.to === 'approve');
      expect(toApprove.length).toBeGreaterThan(0);
    });

    test('approve has edge to close', () => {
      const approveToClose = graph.edges.find((e) => e.from === 'approve' && e.to === 'close');
      expect(approveToClose).toBeDefined();
    });
  });

  describe('zero revision cycles', () => {
    const graph = buildGraph('standard', 0);

    test('has only cycle 0 nodes plus close and retrospective', () => {
      expect(graph.nodes.size).toBe(5); // impl_0, verify_0, review_0, close, retro
    });

    test('no revision edges exist', () => {
      const revisionEdges = graph.edges.filter((e) => e.to.startsWith('implement_1'));
      expect(revisionEdges.length).toBe(0);
    });
  });

  describe('validation', () => {
    test('graph passes cycle detection', () => {
      expect(() => buildGraph('standard', 2)).not.toThrow();
    });
  });

  describe('nodeId helper', () => {
    test('formats as phase_cycle', () => {
      expect(nodeId('implement', 0)).toBe('implement_0');
      expect(nodeId('verify', 2)).toBe('verify_2');
    });
  });
});
