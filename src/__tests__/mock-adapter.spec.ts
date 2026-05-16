import { describe, test, expect } from 'bun:test';
import { MockRuntime } from '../agent/adapters/mock-adapter.js';
import type { SpawnAgentResult } from '../types.js';

describe('MockRuntime', () => {
  test('returns default completed result for unknown agents', async () => {
    const mock = new MockRuntime();
    const result = await mock.spawn({
      prompt: 'test',
      cwd: '/tmp',
      agentName: 'implementer',
      caseRoot: '/tmp',
    });

    expect(result.result.status).toBe('completed');
    expect(result.result.summary).toContain('implementer');
  });

  test('returns preconfigured response for specific agent', async () => {
    const customResult: SpawnAgentResult = {
      raw: 'custom output',
      result: {
        status: 'failed',
        summary: 'Custom failure',
        artifacts: {
          commit: null,
          filesChanged: [],
          testsPassed: false,
          screenshotUrls: [],
          evidenceMarkers: [],
          prUrl: null,
          prNumber: null,
        },
        error: 'test error',
      },
      durationMs: 42,
    };

    const mock = new MockRuntime({ verifier: customResult });
    const result = await mock.spawn({
      prompt: 'test',
      cwd: '/tmp',
      agentName: 'verifier',
      caseRoot: '/tmp',
    });

    expect(result.result.status).toBe('failed');
    expect(result.result.error).toBe('test error');
    expect(result.durationMs).toBe(42);
  });

  test('records spawn calls for assertion', async () => {
    const mock = new MockRuntime();

    await mock.spawn({ prompt: 'p1', cwd: '/a', agentName: 'implementer', caseRoot: '/r' });
    await mock.spawn({ prompt: 'p2', cwd: '/b', agentName: 'verifier', caseRoot: '/r' });
    await mock.spawn({ prompt: 'p3', cwd: '/c', agentName: 'reviewer', caseRoot: '/r' });

    expect(mock.spawnCalls).toHaveLength(3);
    expect(mock.spawnCalls[0].agentName).toBe('implementer');
    expect(mock.spawnCalls[1].agentName).toBe('verifier');
    expect(mock.spawnCalls[2].agentName).toBe('reviewer');
  });

  test('createTools returns empty array', () => {
    const mock = new MockRuntime();
    const tools = mock.createTools('implementer', '/tmp');
    expect(tools).toEqual([]);
  });

  test('abort does not throw', () => {
    const mock = new MockRuntime();
    expect(() => mock.abort()).not.toThrow();
  });
});
