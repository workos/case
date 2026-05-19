import type { AgentName, AgentResult, PipelinePhase, PipelineProfile, RubricCategory, TaskStatus } from '../types.js';
import type { PlanArtifact } from './plan.js';

export interface EventMeta {
  ts: string;
  sequence: number;
  runId: string;
}

export type PipelineEvent =
  | (EventMeta & {
      event: 'pipeline_start';
      taskId: string;
      profile: PipelineProfile;
      plan: PlanArtifact;
    })
  | (EventMeta & {
      event: 'phase_start';
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
    })
  | (EventMeta & {
      event: 'phase_end';
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      outcome: 'completed' | 'failed' | 'skipped';
      durationMs: number;
      result?: AgentResult;
    })
  | (EventMeta & {
      event: 'tool_start';
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      toolCallId: string;
      tool: string;
      args: string;
    })
  | (EventMeta & {
      event: 'tool_end';
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      toolCallId: string;
      tool: string;
      durationMs: number;
      isError: boolean;
      result: string;
    })
  | (EventMeta & {
      event: 'revision_requested';
      source: 'verifier' | 'reviewer';
      cycle: number;
      failedCategories: RubricCategory[];
    })
  | (EventMeta & {
      event: 'revision_budget_exhausted';
      cycles: number;
    })
  | (EventMeta & {
      event: 'fingerprint_match';
      /** Cycle whose fingerprint matched the previous cycle (1-indexed — the cycle being aborted). */
      cycle: number;
      /** Truncated SHA-256 fingerprint (16 hex chars). */
      fingerprint: string;
      /** Previous cycle that produced the same fingerprint. */
      previousCycle: number;
    })
  | (EventMeta & {
      event: 'scout_completed';
      /**
       * Whether the scout returned validated findings (`true`) or a partial /
       * unparseable result that the implementer will run without (`false`).
       * The full structured findings live on the scout node's `phase_end`
       * result; this event is a lightweight audit signal.
       */
      hasFindings: boolean;
      /** Count of files the scout flagged as relevant — 0 when `hasFindings` is false. */
      relevantFileCount: number;
      /** Count of patterns the scout flagged for the implementer to follow. */
      patternCount: number;
      /** Wall-clock duration of the scout dispatch, in ms. */
      durationMs: number;
    })
  | (EventMeta & {
      event: 'status_changed';
      from: TaskStatus;
      to: TaskStatus;
    })
  | (EventMeta & {
      event: 'marker_written';
      marker: string;
      path: string;
    })
  | (EventMeta & {
      event: 'pipeline_end';
      outcome: 'completed' | 'failed';
      failedAgent?: AgentName;
      durationMs: number;
    });

export type PipelineEventType = PipelineEvent['event'];

export type PipelineEventInput = PipelineEvent extends infer E
  ? E extends PipelineEvent
    ? Omit<E, 'sequence' | 'runId' | 'ts'>
    : never
  : never;
