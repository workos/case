/**
 * @deprecated Use PiRuntimeAdapter from './adapters/pi-adapter.js' instead.
 * Retained as a convenience re-export for non-pipeline callers.
 */
import { PiRuntimeAdapter } from './adapters/pi-adapter.js';
import type { SpawnAgentOptions, SpawnAgentResult } from '../types.js';

const adapter = new PiRuntimeAdapter();

export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
  return adapter.spawn(options);
}
