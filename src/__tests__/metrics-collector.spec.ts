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

  it('restores revisionCycles from a resumed run', () => {
    collector.setRevisionCycles(2);
    const metrics = collector.finalize('completed');
    expect(metrics.revisionCycles).toBe(2);
  });

  it('normalizes restored revisionCycles to a non-negative integer', () => {
    collector.setRevisionCycles(-1.8);
    const metrics = collector.finalize('completed');
    expect(metrics.revisionCycles).toBe(0);
  });

  it('records pipeline profile', () => {
    collector.setProfile('complex');
    const metrics = collector.finalize('completed');
    expect(metrics.profile).toBe('complex');
  });

  it('defaults profile to standard', () => {
    const metrics = collector.finalize('completed');
    expect(metrics.profile).toBe('standard');
  });

  it('tracks human overrides', () => {
    collector.addHumanOverride();
    collector.addHumanOverride();
    const metrics = collector.finalize('completed');
    expect(metrics.humanOverrides).toBe(2);
  });

  it('defaults humanOverrides to 0', () => {
    const metrics = collector.finalize('completed');
    expect(metrics.humanOverrides).toBe(0);
  });

  it('records verifier rubric', () => {
    const rubric = [
      { category: 'reproduced-scenario', verdict: 'pass' as const, detail: 'OK' },
      { category: 'edge-case-checked', verdict: 'fail' as const, detail: 'Missing null check' },
    ];
    collector.setVerifierRubric(rubric);
    const metrics = collector.finalize('completed');
    expect(metrics.evaluatorEffectiveness.verifierRubric).toEqual(rubric);
  });

  it('records reviewer rubric', () => {
    const rubric = [
      { category: 'scope-discipline', verdict: 'pass' as const, detail: 'In scope' },
    ];
    collector.setReviewerRubric(rubric);
    const metrics = collector.finalize('completed');
    expect(metrics.evaluatorEffectiveness.reviewerRubric).toEqual(rubric);
  });

  it('records revisionFixedIssues true', () => {
    collector.setRevisionFixedIssues(true);
    const metrics = collector.finalize('completed');
    expect(metrics.evaluatorEffectiveness.revisionFixedIssues).toBe(true);
  });

  it('records revisionFixedIssues false', () => {
    collector.setRevisionFixedIssues(false);
    const metrics = collector.finalize('completed');
    expect(metrics.evaluatorEffectiveness.revisionFixedIssues).toBe(false);
  });

  it('revisionFixedIssues false is not overwritten by true', () => {
    collector.setRevisionFixedIssues(false);
    collector.setRevisionFixedIssues(true);
    const metrics = collector.finalize('completed');
    expect(metrics.evaluatorEffectiveness.revisionFixedIssues).toBe(false);
  });

  it('revisionFixedIssues true can be overwritten by false', () => {
    collector.setRevisionFixedIssues(true);
    collector.setRevisionFixedIssues(false);
    const metrics = collector.finalize('completed');
    expect(metrics.evaluatorEffectiveness.revisionFixedIssues).toBe(false);
  });

  it('accumulates skipped phases', () => {
    collector.addSkippedPhase('verify');
    collector.addSkippedPhase('review');
    const metrics = collector.finalize('completed');
    expect(metrics.evaluatorEffectiveness.skippedPhases).toEqual(['verify', 'review']);
  });

  it('defaults evaluatorEffectiveness to empty/null values', () => {
    const metrics = collector.finalize('completed');
    expect(metrics.evaluatorEffectiveness).toEqual({
      verifierRubric: null,
      reviewerRubric: null,
      revisionFixedIssues: null,
      skippedPhases: [],
    });
  });

  it('finalize includes all new fields in output', () => {
    collector.setProfile('tiny');
    collector.addHumanOverride();
    collector.setVerifierRubric([{ category: 'test', verdict: 'pass', detail: 'ok' }]);
    collector.setRevisionFixedIssues(true);
    collector.addSkippedPhase('verify');

    const metrics = collector.finalize('completed');
    expect(metrics.profile).toBe('tiny');
    expect(metrics.humanOverrides).toBe(1);
    expect(metrics.evaluatorEffectiveness.verifierRubric).toHaveLength(1);
    expect(metrics.evaluatorEffectiveness.revisionFixedIssues).toBe(true);
    expect(metrics.evaluatorEffectiveness.skippedPhases).toEqual(['verify']);
  });
});
