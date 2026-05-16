import type { PipelineEvent } from '../events/schema.js';

export function renderWatchEvent(event: PipelineEvent): string {
  switch (event.event) {
    case 'pipeline_start':
      return `▶ pipeline started (${event.profile} profile, run ${event.runId.slice(0, 8)})`;

    case 'phase_start':
      return `▶ ${event.phase} (${event.agent})`;

    case 'phase_end': {
      const duration = formatDuration(event.durationMs);
      if (event.outcome === 'completed') return `✓ ${event.phase} completed (${duration})`;
      if (event.outcome === 'skipped') return `⊘ ${event.phase} skipped`;
      return `✗ ${event.phase} failed (${duration})`;
    }

    case 'revision_requested':
      return `↻ revision requested by ${event.source} (cycle ${event.cycle})`;

    case 'revision_budget_exhausted':
      return `⚠ revision budget exhausted (${event.cycles} cycles)`;

    case 'status_changed':
      return `→ ${event.to}`;

    case 'pipeline_end': {
      const duration = formatDuration(event.durationMs);
      if (event.outcome === 'completed') return `✓ pipeline complete (${duration})`;
      return `✗ pipeline failed at ${event.failedAgent ?? 'unknown'} (${duration})`;
    }

    case 'marker_written':
      return `📎 marker: ${event.marker}`;

    case 'tool_start':
      return `  ⟫ ${event.tool}`;

    case 'tool_end':
      return `  ⟪ ${event.tool} (${formatDuration(event.durationMs)}${event.isError ? ' ERROR' : ''})`;

    default:
      return `? ${(event as any).event}`;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
