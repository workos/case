import type { AgentName, PhaseMetrics, PipelinePhase, ReviewFindings, RunMetrics } from '../types.js';

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
    };
  }
}
