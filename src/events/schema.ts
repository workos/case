import type { AgentName, AgentResult, PipelinePhase, PipelineProfile, RubricCategory, TaskStatus } from '../types.js';
import type { PlanArtifact } from './plan.js';

export interface EventMeta {
  ts: string;
  sequence: number;
  runId: string;
}

export type PipelineEvent =
  | EventMeta & {
      event: 'pipeline_start';
      taskId: string;
      profile: PipelineProfile;
      plan: PlanArtifact;
    }
  | EventMeta & {
      event: 'phase_start';
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
    }
  | EventMeta & {
      event: 'phase_end';
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      outcome: 'completed' | 'failed' | 'skipped';
      durationMs: number;
      result?: AgentResult;
    }
  | EventMeta & {
      event: 'tool_start';
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      toolCallId: string;
      tool: string;
      args: string;
    }
  | EventMeta & {
      event: 'tool_end';
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      toolCallId: string;
      tool: string;
      durationMs: number;
      isError: boolean;
      result: string;
    }
  | EventMeta & {
      event: 'revision_requested';
      source: 'verifier' | 'reviewer' | 'human';
      cycle: number;
      failedCategories: RubricCategory[];
    }
  | EventMeta & {
      event: 'revision_budget_exhausted';
      cycles: number;
    }
  | EventMeta & {
      event: 'status_changed';
      from: TaskStatus;
      to: TaskStatus;
    }
  | EventMeta & {
      event: 'marker_written';
      marker: string;
      path: string;
    }
  | EventMeta & {
      event: 'pipeline_end';
      outcome: 'completed' | 'failed';
      failedAgent?: AgentName;
      durationMs: number;
    };

export type PipelineEventType = PipelineEvent['event'];

export type PipelineEventInput = PipelineEvent extends infer E
  ? E extends PipelineEvent
    ? Omit<E, 'sequence' | 'runId' | 'ts'>
    : never
  : never;
