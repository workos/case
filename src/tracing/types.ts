import type { AgentName, PipelinePhase } from '../types.js';

/** A single event in a per-run trace log. */
export type TraceEvent =
  | {
      ts: string;
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      event: 'tool_start';
      toolCallId: string;
      tool: string;
      args: string; // truncated + sanitized
    }
  | {
      ts: string;
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      event: 'tool_end';
      toolCallId: string;
      tool: string;
      durationMs: number;
      isError: boolean;
      result: string; // truncated + sanitized
    }
  | {
      ts: string;
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      event: 'phase_start';
    }
  | {
      ts: string;
      phase: PipelinePhase;
      agent: AgentName | 'retrospective';
      event: 'phase_end';
      outcome: 'completed' | 'failed';
      durationMs: number;
    };
