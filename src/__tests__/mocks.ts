/**
 * Shared module mocks — loaded via bunfig.toml [test] preload.
 *
 * These mock.module calls apply globally to all test files in the process.
 * Only mock I/O boundaries here (agent spawning, scripts, file writes).
 * NEVER mock modules that are directly tested (assembler, phases, etc.).
 */
import { mock } from 'bun:test';

// --- I/O boundary mocks ---

/** Mock for spawnAgent — prevents real Pi agent sessions */
export const mockSpawnAgent = mock();
mock.module('../agent/pi-runner.js', () => ({ spawnAgent: mockSpawnAgent }));

/** Mock for runScript — prevents real shell script execution */
export const mockRunScript = mock();
mock.module('../util/run-script.js', () => ({ runScript: mockRunScript }));

/** Mock for writeRunMetrics — prevents real file writes */
export const mockWriteRunMetrics = mock();
mock.module('../metrics/writer.js', () => ({ writeRunMetrics: mockWriteRunMetrics }));

/** Mock for prompt version tracking — prevents real file reads */
export const mockGetCurrentPromptVersions = mock();
export const mockFindPriorRunId = mock();
mock.module('../versioning/prompt-tracker.js', () => ({
  getCurrentPromptVersions: mockGetCurrentPromptVersions,
  findPriorRunId: mockFindPriorRunId,
}));

