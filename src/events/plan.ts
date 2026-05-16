import type { AgentName, PipelineConfig, PipelinePhase, PipelineProfile, TaskJson } from '../types.js';
import { PROFILE_PHASES } from '../types.js';

export interface PlanArtifact {
  runId: string;
  taskId: string;
  profile: PipelineProfile;
  phases: Array<{ phase: PipelinePhase; agent: AgentName | 'retrospective'; evidenceGates: string[] }>;
  revisionBudget: number;
  modelConfig: Record<string, { provider: string; model: string }>;
  generatedAt: string;
}

const PHASE_TO_AGENT: Record<string, AgentName | 'retrospective'> = {
  implement: 'implementer',
  verify: 'verifier',
  review: 'reviewer',
  close: 'closer',
  retrospective: 'retrospective',
};

const PHASE_EVIDENCE_GATES: Record<string, string[]> = {
  implement: ['commit'],
  verify: ['tested'],
  review: ['reviewed'],
  close: ['pr-opened'],
  retrospective: [],
};

export function generatePlan(task: TaskJson, config: PipelineConfig, runId: string): PlanArtifact {
  const profile = task.profile ?? 'standard';
  const phases = PROFILE_PHASES[profile];

  return {
    runId,
    taskId: task.id,
    profile,
    phases: phases.map((phase) => ({
      phase,
      agent: PHASE_TO_AGENT[phase] ?? 'implementer',
      evidenceGates: PHASE_EVIDENCE_GATES[phase] ?? [],
    })),
    revisionBudget: config.maxRevisionCycles ?? 2,
    modelConfig: {},
    generatedAt: new Date().toISOString(),
  };
}
