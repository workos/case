/**
 * Shared module mocks — registered globally via the `test.setupFiles` entry in
 * vite.config.ts, and re-exported so specs can drive/assert the mock functions.
 *
 * Only mock I/O boundaries here (agent spawning, process execution, file writes).
 * NEVER mock modules that are directly tested (assembler, phases, etc.).
 *
 * `vi.mock` is hoisted above module-level declarations, so the mock functions it
 * references must be created inside `vi.hoisted()`.
 */
import { vi } from 'vitest';

const h = vi.hoisted(() => ({
  mockSpawnAgent: vi.fn(),
  mockRunCommand: vi.fn(),
  mockGatherSessionContext: vi.fn(),
  mockAnalyzeFailure: vi.fn(),
  mockWriteRunMetrics: vi.fn(),
  mockGetCurrentPromptVersions: vi.fn(),
  mockFindPriorRunId: vi.fn(),
}));

// --- I/O boundary mocks ---

/** spawnAgent — prevents real Pi agent sessions */
vi.mock('../agent/pi-runner.js', () => ({ spawnAgent: h.mockSpawnAgent }));

/** runCommand — prevents real process execution (git calls in prefetch/baseline) */
vi.mock('../util/run-command.js', () => ({
  runCommand: h.mockRunCommand,
  runCommandLine: h.mockRunCommand,
}));

/** gatherSessionContext — prevents real git/fs access in tests */
vi.mock('../commands/session.js', () => ({
  description: 'Print session context',
  handler: vi.fn(),
  gatherSessionContext: h.mockGatherSessionContext,
}));

/** analyzeFailure — prevents real git/fs access in tests */
vi.mock('../commands/analyze-failure.js', () => ({
  description: 'Analyze failure',
  handler: vi.fn(),
  analyzeFailure: h.mockAnalyzeFailure,
}));

/** writeRunMetrics — prevents real file writes */
vi.mock('../metrics/writer.js', () => ({ writeRunMetrics: h.mockWriteRunMetrics }));

/** prompt version tracking — prevents real file reads */
vi.mock('../versioning/prompt-tracker.js', () => ({
  getCurrentPromptVersions: h.mockGetCurrentPromptVersions,
  findPriorRunId: h.mockFindPriorRunId,
}));

export const mockSpawnAgent = h.mockSpawnAgent;
export const mockRunCommand = h.mockRunCommand;
export const mockGatherSessionContext = h.mockGatherSessionContext;
export const mockAnalyzeFailure = h.mockAnalyzeFailure;
export const mockWriteRunMetrics = h.mockWriteRunMetrics;
export const mockGetCurrentPromptVersions = h.mockGetCurrentPromptVersions;
export const mockFindPriorRunId = h.mockFindPriorRunId;
