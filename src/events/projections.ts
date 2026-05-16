import type { AgentName, AgentPhase, PhaseMetrics, PipelinePhase, ReviewFindings, RubricCategory, RunMetrics, TaskJson } from '../types.js';
import type { PipelineState } from './types.js';

export function projectTaskJson(state: PipelineState): Partial<TaskJson> {
  const agents: Partial<Record<AgentName, AgentPhase>> = {};

  for (const [, phase] of state.phases) {
    if (phase.agent === 'retrospective') continue;
    const agentName = phase.agent as AgentName;
    agents[agentName] = {
      started: phase.startedAt ?? null,
      completed: phase.completedAt ?? null,
      status: phase.status === 'running' ? 'running' : phase.status === 'completed' ? 'completed' : phase.status === 'failed' ? 'failed' : 'pending',
    };
  }

  let prUrl: string | null = null;
  let prNumber: number | null = null;

  for (const [, phase] of state.phases) {
    if (phase.phase === 'close' && phase.result?.artifacts) {
      prUrl = phase.result.artifacts.prUrl;
      prNumber = phase.result.artifacts.prNumber;
    }
  }

  return {
    id: state.taskId,
    status: state.status,
    agents,
    tested: state.markers.has('tested'),
    manualTested: state.markers.has('manual-tested'),
    prUrl,
    prNumber,
    pendingRevision: state.pendingRevision,
    profile: state.profile,
  };
}

export function projectMetrics(state: PipelineState): RunMetrics {
  const phases: PhaseMetrics[] = [];
  let reviewFindings: ReviewFindings | null = null;
  let verifierRubric: RubricCategory[] | null = null;
  let reviewerRubric: RubricCategory[] | null = null;
  const skippedPhases: PipelinePhase[] = [];

  for (const [, phase] of state.phases) {
    if (phase.status === 'skipped') {
      skippedPhases.push(phase.phase);
    }

    phases.push({
      phase: phase.phase,
      agent: phase.agent,
      startedAt: phase.startedAt ?? state.startedAt,
      completedAt: phase.completedAt ?? state.completedAt ?? new Date().toISOString(),
      durationMs: phase.durationMs ?? 0,
      status: phase.status === 'running' ? 'completed' : (phase.status as 'completed' | 'failed' | 'skipped'),
      retried: phase.phase === 'implement' && state.revisionCycles > 0,
    });

    if (phase.result?.findings) {
      reviewFindings = phase.result.findings;
    }
    if (phase.result?.rubric?.role === 'verifier') {
      verifierRubric = phase.result.rubric.categories;
    }
    if (phase.result?.rubric?.role === 'reviewer') {
      reviewerRubric = phase.result.rubric.categories;
    }
  }

  return {
    runId: state.runId,
    startedAt: state.startedAt,
    completedAt: state.completedAt ?? new Date().toISOString(),
    totalDurationMs: state.totalDurationMs ?? 0,
    outcome: state.outcome === 'running' ? 'completed' : state.outcome,
    failedAgent: state.failedAgent,
    phases,
    ciFirstPush: null,
    reviewFindings,
    promptVersions: {},
    revisionCycles: state.revisionCycles,
    profile: state.profile,
    humanOverrides: 0,
    approvalDecision: null,
    approvalTimeMs: null,
    humanRevisionCycles: 0,
    evaluatorEffectiveness: {
      verifierRubric,
      reviewerRubric,
      revisionFixedIssues: null,
      skippedPhases,
    },
  };
}

export function projectMarkers(state: PipelineState): Array<{ name: string; path: string }> {
  const markers: Array<{ name: string; path: string }> = [];

  for (const [, phase] of state.phases) {
    if (phase.phase === 'verify' && phase.status === 'completed') {
      markers.push({ name: 'tested', path: `.case/${state.taskId}/tested` });
    }
    if (phase.phase === 'review' && phase.status === 'completed') {
      markers.push({ name: 'reviewed', path: `.case/${state.taskId}/reviewed` });
    }
  }

  return markers;
}
