/**
 * E2E read-back helpers — re-exported from the shared source module.
 *
 * Phase 2.1 introduced these here; Phase 2.2 promoted them to
 * `src/tracing/readback.ts` so `ca watch` shares the same read-only client.
 * Kept as a thin re-export so the e2e specs' import path is unchanged.
 */
export {
  readConfig,
  e2eEnabled,
  llmE2eEnabled,
  makeReadClient,
  listLatestTraceIdByName,
  getTraceDetails,
  pollTrace,
  byName,
  ofType,
  type ReadConfig,
  type Observation,
  type TraceScore,
  type TraceDetails,
} from '../../src/tracing/readback.js';
