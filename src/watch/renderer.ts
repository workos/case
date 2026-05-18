import type { PipelineEvent } from '../events/schema.js';
import { formatDuration, formatPhaseEnd, formatPhaseHeader, formatToolLine } from '../render/format.js';
import { cyan, dim, green, red, yellow } from '../render/color.js';

/**
 * Render a single PipelineEvent for `ca watch`. Uses the same formatting
 * primitives as the inline structured log, with colors applied (respecting
 * NO_COLOR / FORCE_COLOR / TTY detection in `render/color.ts`).
 */
export function renderWatchEvent(event: PipelineEvent): string {
  switch (event.event) {
    case 'pipeline_start':
      return cyan(`▶ pipeline started (${event.profile} profile, run ${event.runId.slice(0, 8)})`);

    case 'phase_start':
      return formatPhaseHeader(event.phase, event.agent);

    case 'phase_end': {
      if (event.outcome === 'skipped') {
        return dim(`⊘ ${event.phase} skipped`);
      }
      const status = event.outcome === 'completed' ? 'completed' : 'failed';
      const raw = formatPhaseEnd(event.phase, event.agent, event.durationMs, status);
      const icon = status === 'completed' ? green(raw[0]!) : red(raw[0]!);
      return `${icon}${raw.slice(1)}`;
    }

    case 'tool_start':
      return dim(formatToolLine(event.tool, event.args));

    case 'tool_end': {
      const line = dim(formatToolLine(event.tool, '', event.durationMs));
      return event.isError ? `${line}${red(' ERROR')}` : line;
    }

    case 'revision_requested':
      return yellow(`↻ revision requested by ${event.source} (cycle ${event.cycle})`);

    case 'revision_budget_exhausted':
      return yellow(`⚠ revision budget exhausted (${event.cycles} cycles)`);

    case 'status_changed':
      return dim(`→ ${event.to}`);

    case 'pipeline_end':
      return event.outcome === 'completed'
        ? green(`✓ pipeline complete (${formatDuration(event.durationMs)})`)
        : red(`✗ pipeline failed at ${event.failedAgent ?? 'unknown'} (${formatDuration(event.durationMs)})`);

    case 'marker_written':
      return dim(`📎 marker: ${event.marker}`);

    default:
      return dim(`? ${(event as { event: string }).event}`);
  }
}
