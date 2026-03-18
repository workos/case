/**
 * Direct unit tests for spawnAgent (pi-runner.ts).
 *
 * This file tests the real spawnAgent function with Pi SDK mocked at the
 * package level. Run with: bun test --preload="" src/__tests__/pi-runner-unit.spec.ts
 * (bypasses the global preload that replaces spawnAgent with a mock)
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { AgentEvent } from '@mariozechner/pi-agent-core';

// --- Mock Pi SDK before importing pi-runner ---

let mockSubscriber: ((event: AgentEvent) => void) | null = null;
const mockPromptFn = mock();
const mockAbortFn = mock();

mock.module('@mariozechner/pi-agent-core', () => ({
  Agent: class MockAgent {
    constructor() {}
    subscribe(fn: (e: AgentEvent) => void) {
      mockSubscriber = fn;
      return () => { mockSubscriber = null; };
    }
    prompt(...args: any[]) { return mockPromptFn(...args); }
    abort() { return mockAbortFn(); }
  },
}));

mock.module('@mariozechner/pi-ai', () => ({
  streamSimple: mock(),
}));

mock.module('@mariozechner/pi-coding-agent', () => ({
  createReadTool: mock(() => ({ name: 'read', label: 'Read' })),
  createWriteTool: mock(() => ({ name: 'write', label: 'Write' })),
  createEditTool: mock(() => ({ name: 'edit', label: 'Edit' })),
  createBashTool: mock(() => ({ name: 'bash', label: 'Bash' })),
  AuthStorage: { create: () => ({}) },
  ModelRegistry: class MockModelRegistry {
    constructor() {}
    find() { return { id: 'mock-model', provider: 'anthropic' }; }
  },
}));

mock.module('../../src/agent/prompt-loader.js', () => ({
  loadSystemPrompt: mock(() => Promise.resolve('You are a test agent.')),
}));

// Import the real pi-runner (no preload intercepting it in this file)
const { spawnAgent } = await import('../../src/agent/pi-runner.js');

// --- Helpers ---

function emitTextDelta(delta: string) {
  mockSubscriber?.({
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: delta }], timestamp: Date.now() } as any,
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: {} as any },
  });
}

function emitToolStart(toolName: string) {
  mockSubscriber?.({
    type: 'tool_execution_start',
    toolCallId: `tc-${toolName}`,
    toolName,
    args: {},
  });
}

const VALID_AGENT_RESULT = [
  '<<<AGENT_RESULT',
  JSON.stringify({
    status: 'completed',
    summary: 'Done',
    artifacts: { commit: 'abc123', filesChanged: ['a.ts'], testsPassed: true, screenshotUrls: [], evidenceMarkers: [], prUrl: null, prNumber: null },
    error: null,
  }),
  'AGENT_RESULT>>>',
].join('\n');

const BASE_OPTIONS = {
  prompt: 'Fix the bug',
  cwd: '/repos/cli',
  agentName: 'implementer' as const,
  caseRoot: '/case',
};

describe('spawnAgent (direct unit tests)', () => {
  beforeEach(() => {
    mockSubscriber = null;
    mockPromptFn.mockReset();
    mockAbortFn.mockReset();
  });

  it('collects response text from streaming events and parses AGENT_RESULT', async () => {
    mockPromptFn.mockImplementation(async () => {
      emitTextDelta('Some output\n');
      emitTextDelta(VALID_AGENT_RESULT);
    });

    const { result, raw, durationMs } = await spawnAgent(BASE_OPTIONS);

    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Done');
    expect(result.artifacts.commit).toBe('abc123');
    expect(result.artifacts.testsPassed).toBe(true);
    expect(raw).toContain('AGENT_RESULT');
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns failed result when no AGENT_RESULT delimiters', async () => {
    mockPromptFn.mockImplementation(async () => {
      emitTextDelta('Just some text without delimiters');
    });

    const { result } = await spawnAgent(BASE_OPTIONS);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('AGENT_RESULT start delimiter not found');
  });

  it('returns failed result on agent throw (error handling)', async () => {
    mockPromptFn.mockRejectedValue(new Error('API key invalid'));

    const { result, durationMs } = await spawnAgent(BASE_OPTIONS);

    expect(result.status).toBe('failed');
    expect(result.error).toContain('API key invalid');
    expect(result.artifacts.commit).toBeNull();
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fires heartbeat callback on tool_execution_start events', async () => {
    const heartbeats: number[] = [];
    mockPromptFn.mockImplementation(async () => {
      emitToolStart('bash');
      emitToolStart('read');
      emitTextDelta(VALID_AGENT_RESULT);
    });

    await spawnAgent({ ...BASE_OPTIONS, onHeartbeat: (ms) => heartbeats.push(ms) });

    expect(heartbeats.length).toBe(2);
    expect(heartbeats[0]).toBeGreaterThanOrEqual(0);
    expect(heartbeats[1]).toBeGreaterThanOrEqual(heartbeats[0]);
  });

  it('does not fire heartbeat when no callback provided', async () => {
    mockPromptFn.mockImplementation(async () => {
      emitToolStart('bash');
      emitTextDelta(VALID_AGENT_RESULT);
    });

    // Should not throw even without onHeartbeat
    const { result } = await spawnAgent(BASE_OPTIONS);
    expect(result.status).toBe('completed');
  });

  it('calls agent.abort() when timeout expires', async () => {
    // Simulate a prompt that hangs until aborted
    mockPromptFn.mockImplementation(() => {
      return new Promise<void>((resolve) => {
        // The abort should fire before this resolves
        setTimeout(resolve, 5000);
      });
    });

    // Use a very short timeout to trigger the abort path
    const { result } = await spawnAgent({ ...BASE_OPTIONS, timeout: 50 });

    // abort() should have been called by the setTimeout in pi-runner
    expect(mockAbortFn).toHaveBeenCalled();
    // Since prompt resolves (eventually) after abort, we get a failed result
    // because no AGENT_RESULT was emitted
    expect(result.status).toBe('failed');
  });
});
