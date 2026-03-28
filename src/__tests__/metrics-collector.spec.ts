import { describe, it, expect, beforeEach } from 'bun:test';
import { MetricsCollector } from '../metrics/collector.js';

describe('MetricsCollector', () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it('generates a unique runId', () => {
    const other = new MetricsCollector();
    expect(collector.runId).not.toBe(other.runId);
    expect(collector.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('tracks phase timing', () => {
    collector.startPhase('implement', 'implementer');
    collector.endPhase('completed');

    const metrics = collector.finalize('completed');
    expect(metrics.phases).toHaveLength(1);
    expect(metrics.phases[0].phase).toBe('implement');
    expect(metrics.phases[0].agent).toBe('implementer');
    expect(metrics.phases[0].status).toBe('completed');
    expect(metrics.phases[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('tracks multiple phases', () => {
    collector.startPhase('implement', 'implementer');
    collector.endPhase('completed');
    collector.startPhase('verify', 'verifier');
    collector.endPhase('completed');
    collector.startPhase('review', 'reviewer');
    collector.endPhase('failed');

    const metrics = collector.finalize('failed', 'reviewer');
    expect(metrics.phases).toHaveLength(3);
    expect(metrics.outcome).toBe('failed');
    expect(metrics.failedAgent).toBe('reviewer');
  });

  it('records CI first-push status', () => {
    collector.setCiFirstPush(true);
    const metrics = collector.finalize('completed');
    expect(metrics.ciFirstPush).toBe(true);
  });

  it('records review findings', () => {
    collector.setReviewFindings({
      critical: 1,
      warnings: 3,
      info: 5,
      details: [],
    });
    const metrics = collector.finalize('completed');
    expect(metrics.reviewFindings?.critical).toBe(1);
    expect(metrics.reviewFindings?.warnings).toBe(3);
  });

  it('records prompt versions', () => {
    collector.setPromptVersions({ implementer: 'v3-2026-03-10', verifier: 'v2-2026-03-01' });
    const metrics = collector.finalize('completed');
    expect(metrics.promptVersions.implementer).toBe('v3-2026-03-10');
  });

  it('tracks retried flag', () => {
    collector.startPhase('implement', 'implementer');
    collector.endPhase('completed', true);

    const metrics = collector.finalize('completed');
    expect(metrics.phases[0].retried).toBe(true);
  });

  it('ignores endPhase when no phase is active', () => {
    collector.endPhase('completed');
    const metrics = collector.finalize('completed');
    expect(metrics.phases).toHaveLength(0);
  });

  it('calculates total duration', () => {
    const metrics = collector.finalize('completed');
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.startedAt).toBeTruthy();
    expect(metrics.completedAt).toBeTruthy();
  });

  it('tracks revision cycles', () => {
    collector.addRevisionCycle();
    collector.addRevisionCycle();
    const metrics = collector.finalize('completed');
    expect(metrics.revisionCycles).toBe(2);
  });

  it('defaults revisionCycles to 0', () => {
    const metrics = collector.finalize('completed');
    expect(metrics.revisionCycles).toBe(0);
  });
});
