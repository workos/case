/**
 * @deprecated Use PiRuntimeAdapter.createTools() from './adapters/pi-adapter.js' instead.
 * Retained as a convenience re-export.
 */
import { PiRuntimeAdapter } from './adapters/pi-adapter.js';

const adapter = new PiRuntimeAdapter();

export function getToolsForAgent(agentName: string, cwd: string) {
  return adapter.createTools(agentName, cwd);
}
