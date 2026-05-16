import { readFile } from 'node:fs/promises';
import type { PipelineEvent } from './schema.js';
import type { PipelineState } from './types.js';

export function reduceEvents(events: PipelineEvent[]): PipelineState {
  let state: PipelineState | null = null;

  for (const event of events) {
    state = applyEvent(state, event);
  }

  if (state === null) {
    throw new Error('No events to reduce — expected at least a pipeline_start event');
  }

  return state;
}

export function applyEvent(state: PipelineState | null, event: PipelineEvent): PipelineState {
  switch (event.event) {
    case 'pipeline_start': {
      return {
        runId: event.runId,
        taskId: event.taskId,
        profile: event.profile,
        plan: event.plan,
        status: 'active',
        phases: new Map(),
        currentPhase: null,
        revisionCycles: 0,
        pendingRevision: null,
        markers: new Set(),
        outcome: 'running',
        startedAt: event.ts,
        lastSequence: event.sequence,
      };
    }

    case 'phase_start': {
      const s = ensureState(state, event);
      const key = `${event.phase}_${s.revisionCycles}`;
      const updated = cloneState(s);
      updated.phases.set(key, {
        phase: event.phase,
        agent: event.agent,
        status: 'running',
        startedAt: event.ts,
      });
      updated.currentPhase = key;
      updated.lastSequence = event.sequence;
      return updated;
    }

    case 'phase_end': {
      const s = ensureState(state, event);
      const updated = cloneState(s);
      if (updated.currentPhase) {
        const phaseState = updated.phases.get(updated.currentPhase);
        if (phaseState) {
          phaseState.status = event.outcome === 'completed' ? 'completed' : event.outcome === 'skipped' ? 'skipped' : 'failed';
          phaseState.completedAt = event.ts;
          phaseState.durationMs = event.durationMs;
          if (event.result) phaseState.result = event.result;
        }
      }
      updated.currentPhase = null;
      updated.lastSequence = event.sequence;
      return updated;
    }

    case 'revision_requested': {
      const s = ensureState(state, event);
      const updated = cloneState(s);
      updated.revisionCycles = event.cycle;
      updated.pendingRevision = {
        source: event.source,
        failedCategories: event.failedCategories,
        summary: '',
        suggestedFocus: [],
        cycle: event.cycle,
      };
      updated.lastSequence = event.sequence;
      return updated;
    }

    case 'revision_budget_exhausted': {
      const s = ensureState(state, event);
      const updated = cloneState(s);
      updated.lastSequence = event.sequence;
      return updated;
    }

    case 'status_changed': {
      const s = ensureState(state, event);
      const updated = cloneState(s);
      updated.status = event.to;
      updated.lastSequence = event.sequence;
      return updated;
    }

    case 'marker_written': {
      const s = ensureState(state, event);
      const updated = cloneState(s);
      updated.markers.add(event.marker);
      updated.lastSequence = event.sequence;
      return updated;
    }

    case 'pipeline_end': {
      const s = ensureState(state, event);
      const updated = cloneState(s);
      updated.outcome = event.outcome;
      updated.completedAt = event.ts;
      updated.totalDurationMs = event.durationMs;
      if (event.failedAgent) updated.failedAgent = event.failedAgent;
      updated.lastSequence = event.sequence;
      return updated;
    }

    case 'tool_start':
    case 'tool_end': {
      const s = ensureState(state, event);
      const updated = cloneState(s);
      updated.lastSequence = event.sequence;
      return updated;
    }

    default: {
      if (state) {
        const updated = cloneState(state);
        updated.lastSequence = (event as PipelineEvent).sequence;
        return updated;
      }
      return state!;
    }
  }
}

function ensureState(state: PipelineState | null, event: PipelineEvent): PipelineState {
  if (!state) throw new Error(`Event "${event.event}" (sequence ${event.sequence}) received before pipeline_start — event log may be missing or its first line may be corrupt`);
  return state;
}

function cloneState(state: PipelineState): PipelineState {
  return {
    ...state,
    phases: new Map(state.phases),
    markers: new Set(state.markers),
  };
}

export async function loadEventsFromFile(filePath: string): Promise<PipelineEvent[]> {
  const content = await readFile(filePath, 'utf-8');
  const events: PipelineEvent[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as PipelineEvent);
    } catch {
      // Skip unparseable trailing lines (crash tolerance)
    }
  }

  return events;
}
