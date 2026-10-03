import type { WatchRecord } from './watcher.js';
import { formatDuration } from '../render/format.js';
import { cyan, dim, green, red, yellow } from '../render/color.js';

/**
 * Render a single `ca watch` record (a Langfuse observation, Phase 2.2) for the
 * terminal tail. Uses the same color primitives as the inline structured log.
 */
export function renderWatchEvent(record: WatchRecord): string {
  switch (record.kind) {
    case 'trace_start':
      return cyan(`▶ watching ${record.traceName} (trace ${record.traceId.slice(0, 8)})`);

    case 'span_start':
      if (record.span === 'phase') return cyan(`▶ ${record.name}`);
      if (record.span === 'tool') return dim(`  ⚙ ${record.name}`);
      return dim(`  · ${record.name}`);

    case 'span_end': {
      const dur = formatDuration(record.durationMs);
      if (record.span === 'phase') {
        return record.isError ? red(`✗ ${record.name} (${dur})`) : green(`✓ ${record.name} (${dur})`);
      }
      const line = dim(`  ⚙ ${record.name} (${dur})`);
      return record.isError ? `${line}${red(' ERROR')}` : line;
    }

    case 'generation': {
      const parts: string[] = [];
      if (record.tokens !== undefined) parts.push(`${record.tokens} tok`);
      if (record.cost !== undefined) parts.push(`$${record.cost.toFixed(4)}`);
      const meta = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return dim(`  ↳ turn${record.model ? ` ${record.model}` : ''}${meta}`);
    }

    case 'event':
      return yellow(`↻ ${record.name}`);

    case 'score':
      return dim(`★ ${record.name}: ${record.value}${record.comment ? ` — ${record.comment}` : ''}`);

    case 'run_complete':
      return green('✓ run complete');

    default:
      return dim(`? ${(record as { kind: string }).kind}`);
  }
}
