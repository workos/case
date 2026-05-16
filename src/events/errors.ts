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
      if (state!.currentPhase !== null) {
        throw new LifecycleValidationError(
          event,
          state,
          `Cannot start phase while another phase is running: ${state!.currentPhase}`,
        );
      }
      return;
    }

    case 'phase_end': {
      assertRunning(event, state);
      if (state!.currentPhase === null) {
        throw new LifecycleValidationError(event, state, 'Cannot end phase that is not running');
      }
      const running = state!.phases.get(state!.currentPhase);
      if (running && running.phase !== event.phase) {
        throw new LifecycleValidationError(
          event,
          state,
          `Phase end does not match running phase: expected ${running.phase}, got ${event.phase}`,
        );
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
