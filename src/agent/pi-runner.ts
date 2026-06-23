/**
 * @deprecated Inject `config.runtime` instead. Retained as a convenience
 * re-export for the phase modules that still import `spawnAgent` directly.
 *
 * Routes through {@link ProviderRoutingRuntime} (Claude → Agent SDK, others →
 * LangChain, `CASE_AGENT_RUNTIME` override) — NOT pi directly — so these callers
 * pick up provider routing without per-phase edits.
 */
import { ProviderRoutingRuntime } from './adapters/provider-routing-runtime.js';
import type { SpawnAgentOptions, SpawnAgentResult } from '../types.js';

const adapter = new ProviderRoutingRuntime();

export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
  return adapter.spawn(options);
}
