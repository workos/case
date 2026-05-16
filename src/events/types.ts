import type { AgentName, AgentResult, PipelinePhase, PipelineProfile, RevisionRequest, TaskStatus } from '../types.js';
import type { PlanArtifact } from './plan.js';

export interface PhaseState {
  phase: PipelinePhase;
  agent: AgentName | 'retrospective';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  result?: AgentResult;
}

export interface PipelineState {
  runId: string;
  taskId: string;
  profile: PipelineProfile;
  plan: PlanArtifact;
  status: TaskStatus;
  phases: Map<string, PhaseState>;
  currentPhase: string | null;
  runningPhases: Set<string>;
  revisionCycles: number;
  pendingRevision: RevisionRequest | null;
  markers: Set<string>;
  outcome: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  totalDurationMs?: number;
  failedAgent?: AgentName;
  lastSequence: number;
}
