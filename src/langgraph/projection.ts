import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskStore } from '../state/task-store.js';
import type { PipelineState } from '../events/types.js';
import { projectTaskJson, projectMarkers } from '../events/projections.js';

/**
 * Node-direct projection of the td mirror + evidence markers (RFC §1.3 step 2).
 *
 * Phase 1.2 derived these as a side-effect of every `EventAppender.append()`.
 * Phase 1.3 moves the trigger to node completion inside the engine — the same
 * synchronous point — so the writes no longer ride the event hop and survive the
 * appender's eventual deletion in 2.2. The disk markers remain the gate truth
 * (§1 constraint 4); td remains the coarse human mirror.
 *
 * The read source is still `PipelineState` (the appender keeps maintaining it via
 * `applyEvent` until 2.2); only the call site moved. `state.markers` is mutated
 * here to dedupe repeat writes, exactly as the appender did.
 */
export async function projectNodeState(state: PipelineState, store: TaskStore, caseRoot: string): Promise<void> {
  await store.writeFromProjection(projectTaskJson(state));

  const markers = projectMarkers(state);
  let wroteMarker = false;
  for (const marker of markers) {
    if (state.markers.has(marker.name)) continue;
    const markerPath = resolve(caseRoot, marker.path);
    await mkdir(resolve(markerPath, '..'), { recursive: true });
    await writeFile(markerPath, new Date().toISOString());
    state.markers.add(marker.name);
    wroteMarker = true;
  }

  // Re-project once markers landed so the td mirror's tested/manual-tested flags
  // reflect the freshly-written evidence in the same node tick.
  if (wroteMarker) await store.writeFromProjection(projectTaskJson(state));
}
