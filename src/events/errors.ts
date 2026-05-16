import type { PipelineEvent } from './schema.js';
import type { PipelineState } from './types.js';

export class LifecycleValidationError extends Error {
  override readonly name = 'LifecycleValidationError';

  constructor(
    public readonly event: PipelineEvent,
    public readonly currentState: PipelineState | null,
    public readonly reason: string,
  ) {
    super(`Invalid lifecycle transition: ${reason}`);
  }
}

export function validateTransition(event: PipelineEvent, state: PipelineState | null): void | never {
  switch (event.event) {
    case 'pipeline_start': {
      if (state !== null) {
        throw new LifecycleValidationError(event, state, 'Pipeline already started');
      }
      return;
    }

    case 'phase_start': {
      assertRunning(event, state);
      // Allow concurrent phases (e.g., verify + review in DAG executor)
      return;
    }

    case 'phase_end': {
      assertRunning(event, state);
      // Allow phase_end for skipped phases that were never started
      if (event.outcome === 'skipped') return;
      // Verify at least one phase is running
      if (state!.runningPhases.size === 0 && state!.currentPhase === null) {
        throw new LifecycleValidationError(event, state, 'Cannot end phase when no phases are running');
      }
      return;
    }

    case 'revision_requested': {
      assertRunning(event, state);
      const hasEvaluator = Array.from(state!.phases.values()).some(
        (p) => (p.phase === 'verify' || p.phase === 'review') && p.status === 'completed',
      );
      if (!hasEvaluator) {
        throw new LifecycleValidationError(event, state, 'Cannot request revision without evaluator output');
      }
      return;
    }

    case 'pipeline_end': {
      assertRunning(event, state);
      return;
    }

    case 'tool_start':
    case 'tool_end':
    case 'revision_budget_exhausted':
    case 'status_changed':
    case 'marker_written': {
      assertRunning(event, state);
      return;
    }

    default: {
      assertRunning(event, state);
    }
  }
}

function assertRunning(event: PipelineEvent, state: PipelineState | null): asserts state is PipelineState {
  if (state === null) {
    throw new LifecycleValidationError(event, state, 'Pipeline not started');
  }
  if (state.outcome !== 'running') {
    throw new LifecycleValidationError(event, state, 'Cannot append events after pipeline end');
  }
}
