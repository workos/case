import type { AgentName, EvaluatorEffectiveness, PhaseMetrics, PipelinePhase, PipelineProfile, ReviewFindings, RubricCategory, RunMetrics } from '../types.js';

export interface MetricsSnapshot {
  revisionCycles: number;
  humanOverrides: number;
  profile: PipelineProfile;
  evaluatorEffectiveness: EvaluatorEffectiveness;
}

/**
 * Collects per-phase timing and structured metrics during a pipeline run.
 * Created once at pipeline start, finalized at pipeline end.
 */
export class MetricsCollector {
  readonly runId: string;
  private readonly startedAt: string;
  private phases: PhaseMetrics[] = [];
  private activePhase: { phase: PipelinePhase; agent: AgentName | 'retrospective'; startedAt: string } | null = null;
  private reviewFindings: ReviewFindings | null = null;
  private ciFirstPush: boolean | null = null;
  private promptVersions: Record<string, string> = {};
  private revisionCycles = 0;
  private profile: PipelineProfile = 'standard';
  private humanOverrides = 0;
  private verifierRubric: RubricCategory[] | null = null;
  private reviewerRubric: RubricCategory[] | null = null;
  private revisionFixedIssues: boolean | null = null;
  private skippedPhases: PipelinePhase[] = [];

  constructor() {
    this.runId = crypto.randomUUID();
    this.startedAt = new Date().toISOString();
  }

  /** Call when entering a pipeline phase. */
  startPhase(phase: PipelinePhase, agent: AgentName | 'retrospective'): void {
    this.activePhase = { phase, agent, startedAt: new Date().toISOString() };
  }

  /** Call when a phase completes (success or failure). */
  endPhase(status: 'completed' | 'failed' | 'skipped', retried = false): void {
    if (!this.activePhase) return;

    const now = new Date().toISOString();
    this.phases.push({
      phase: this.activePhase.phase,
      agent: this.activePhase.agent,
      startedAt: this.activePhase.startedAt,
      completedAt: now,
      durationMs: Date.parse(now) - Date.parse(this.activePhase.startedAt),
      status,
      retried,
    });

    this.activePhase = null;
  }

  /** Record whether the implementer's first push passed CI. */
  setCiFirstPush(passed: boolean): void {
    this.ciFirstPush = passed;
  }

  /** Record reviewer findings for this run. */
  setReviewFindings(findings: ReviewFindings): void {
    this.reviewFindings = findings;
  }

  /** Record prompt versions active during this run. */
  setPromptVersions(versions: Record<string, string>): void {
    this.promptVersions = versions;
  }

  /** Increment the revision cycle counter. */
  addRevisionCycle(): void {
    this.revisionCycles++;
  }

  /** Restore the revision cycle counter when resuming a persisted revision loop. */
  setRevisionCycles(count: number): void {
    this.revisionCycles = Math.max(0, Math.trunc(count));
  }

  /** Set the pipeline profile for this run. */
  setProfile(profile: PipelineProfile): void {
    this.profile = profile;
  }

  /** Record that a human overrode an evaluator decision. */
  addHumanOverride(): void {
    this.humanOverrides++;
  }

  /** Record verifier rubric results. */
  setVerifierRubric(rubric: RubricCategory[]): void {
    this.verifierRubric = rubric;
  }

  /** Record reviewer rubric results. */
  setReviewerRubric(rubric: RubricCategory[]): void {
    this.reviewerRubric = rubric;
  }

  /** Record whether a revision cycle resolved the evaluator's findings.
   *  Once set to false (budget exhausted), a later clean pass cannot overwrite to true. */
  setRevisionFixedIssues(fixed: boolean): void {
    if (this.revisionFixedIssues === false && fixed) return;
    this.revisionFixedIssues = fixed;
  }

  /** Record a phase skipped by profile (deduplicated). */
  addSkippedPhase(phase: PipelinePhase): void {
    if (!this.skippedPhases.includes(phase)) {
      this.skippedPhases.push(phase);
    }
  }

  private buildEvaluatorEffectiveness(): EvaluatorEffectiveness {
    return {
      verifierRubric: this.verifierRubric ? [...this.verifierRubric] : null,
      reviewerRubric: this.reviewerRubric ? [...this.reviewerRubric] : null,
      revisionFixedIssues: this.revisionFixedIssues,
      skippedPhases: [...this.skippedPhases],
    };
  }

  /** Return a read-only snapshot of metrics collected so far (pre-finalization). */
  snapshot(): MetricsSnapshot {
    return {
      revisionCycles: this.revisionCycles,
      humanOverrides: this.humanOverrides,
      profile: this.profile,
      evaluatorEffectiveness: this.buildEvaluatorEffectiveness(),
    };
  }

  /** Finalize and return the complete metrics for this run. */
  finalize(outcome: 'completed' | 'failed', failedAgent?: AgentName): RunMetrics {
    const completedAt = new Date().toISOString();

    return {
      runId: this.runId,
      startedAt: this.startedAt,
      completedAt,
      totalDurationMs: Date.parse(completedAt) - Date.parse(this.startedAt),
      outcome,
      failedAgent,
      phases: this.phases,
      ciFirstPush: this.ciFirstPush,
      reviewFindings: this.reviewFindings,
      promptVersions: this.promptVersions,
      revisionCycles: this.revisionCycles,
      profile: this.profile,
      humanOverrides: this.humanOverrides,
      evaluatorEffectiveness: this.buildEvaluatorEffectiveness(),
    };
  }
}
