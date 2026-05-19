/**
 * Format structured working memory as a concise bullet-list section the
 * orchestrator can prepend to an agent prompt.
 *
 * Per spec: bullets, not raw JSON. Empty/whitespace-only sections are
 * omitted so the agent's context isn't padded with placeholder headers.
 *
 * Variants:
 *   - `formatForImplementer` — full context (state, approach, files, errors,
 *     attempts, blockers). Used before dispatching the implementer so it
 *     inherits everything from prior cycles.
 *   - `formatForVerifier` — just files changed + current approach. The
 *     verifier needs to know what to test, not what was retried.
 */
import type { WorkingMemory } from '../types.js';

export function formatForImplementer(memory: WorkingMemory): string {
  const lines: string[] = ['## Prior Context (from working-memory.json)', ''];

  if (memory.currentState) lines.push(`- **Last state**: ${memory.currentState}`);
  if (memory.approach) lines.push(`- **Approach**: ${memory.approach}`);

  if (memory.filesChanged.length > 0) {
    lines.push('- **Files touched so far**:');
    for (const file of memory.filesChanged) lines.push(`  - \`${file}\``);
  }

  if (memory.approachesTried.length > 0) {
    lines.push('- **Approaches tried** (do NOT repeat failed ones):');
    for (const a of memory.approachesTried) {
      const reason = a.reason ? ` — ${a.reason}` : '';
      lines.push(`  - [${a.outcome}] ${a.approach}${reason}`);
    }
  }

  if (memory.errorsSeen.length > 0) {
    lines.push('- **Errors seen**:');
    for (const e of memory.errorsSeen) {
      const file = e.file ? ` (${e.file})` : '';
      lines.push(`  - [${e.resolution}] ${e.error}${file}`);
    }
  }

  if (memory.blockers.length > 0) {
    lines.push('- **Blockers**:');
    for (const b of memory.blockers) lines.push(`  - ${b}`);
  }

  lines.push(`- **Last updated**: ${memory.updatedAt}`);
  lines.push('');
  return lines.join('\n');
}

export function formatForVerifier(memory: WorkingMemory): string {
  const lines: string[] = ['## Prior Context (from working-memory.json)', ''];

  if (memory.approach) lines.push(`- **Implementer approach**: ${memory.approach}`);

  if (memory.filesChanged.length > 0) {
    lines.push('- **Files the implementer changed**:');
    for (const file of memory.filesChanged) lines.push(`  - \`${file}\``);
  }

  if (memory.errorsSeen.length > 0) {
    lines.push('- **Errors encountered during implementation**:');
    for (const e of memory.errorsSeen) lines.push(`  - [${e.resolution}] ${e.error}`);
  }

  lines.push(`- **Last updated**: ${memory.updatedAt}`);
  lines.push('');
  return lines.join('\n');
}

/** Derive the task slug from a `taskJsonPath` like `/path/.case/tasks/active/<slug>.task.json`. */
export function taskSlugFromTaskJsonPath(taskJsonPath: string): string {
  const base = taskJsonPath.split('/').pop() ?? taskJsonPath;
  return base.replace(/\.task\.json$/, '');
}
