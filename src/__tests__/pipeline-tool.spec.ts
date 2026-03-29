import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Pipeline tool tests.
 *
 * Tests the ToolDefinition wrapper around runPipeline — parameter handling,
 * progress streaming, error propagation. The actual pipeline is mocked.
 */

const mockRunPipeline = mock();
const mockBuildPipelineConfig = mock();

mock.module('../pipeline.js', () => ({ runPipeline: mockRunPipeline }));
mock.module('../config.js', () => ({ buildPipelineConfig: mockBuildPipelineConfig }));

const { createPipelineTool } = await import('../agent/tools/pipeline-tool.js');

describe('createPipelineTool', () => {
  const tool = createPipelineTool('/case');

  beforeEach(() => {
    mockRunPipeline.mockReset();
    mockBuildPipelineConfig.mockReset();

    mockBuildPipelineConfig.mockResolvedValue({
      mode: 'attended',
      taskJsonPath: '/case/tasks/active/cli-1.task.json',
      taskMdPath: '/case/tasks/active/cli-1.md',
      repoPath: '/repos/cli',
      repoName: 'cli',
      caseRoot: '/case',
      maxRetries: 1,
      dryRun: false,
    });
    mockRunPipeline.mockResolvedValue(undefined);
  });

  it('has correct tool metadata', () => {
    expect(tool.name).toBe('run_pipeline');
    expect(tool.label).toBe('Pipeline');
    expect(tool.description).toContain('pipeline');
    expect(tool.promptSnippet).toBeDefined();
  });

  it('calls buildPipelineConfig with correct params', async () => {
    await tool.execute('call-1', { taskJsonPath: '/tasks/test.task.json' }, undefined, undefined, {} as any);

    expect(mockBuildPipelineConfig).toHaveBeenCalledWith({
      taskJsonPath: '/tasks/test.task.json',
      mode: 'attended',
      dryRun: false,
      approve: false,
    });
  });

  it('passes mode and dryRun when provided', async () => {
    await tool.execute(
      'call-2',
      { taskJsonPath: '/tasks/test.task.json', mode: 'unattended', dryRun: true },
      undefined,
      undefined,
      {} as any,
    );

    expect(mockBuildPipelineConfig).toHaveBeenCalledWith({
      taskJsonPath: '/tasks/test.task.json',
      mode: 'unattended',
      dryRun: true,
      approve: false,
    });
  });

  it('calls runPipeline with the built config', async () => {
    await tool.execute('call-3', { taskJsonPath: '/tasks/test.task.json' }, undefined, undefined, {} as any);

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const config = mockRunPipeline.mock.calls[0][0];
    expect(config.repoName).toBe('cli');
  });

  it('returns success content on completion', async () => {
    const result = await tool.execute(
      'call-4',
      { taskJsonPath: '/tasks/test.task.json' },
      undefined,
      undefined,
      {} as any,
    );

    expect(result.content[0]).toEqual({ type: 'text', text: 'Pipeline completed successfully.' });
    expect(result.details).toEqual({ taskJsonPath: '/tasks/test.task.json' });
  });

  it('streams progress via onUpdate when heartbeat fires', async () => {
    const updates: unknown[] = [];
    const onUpdate = mock((update: unknown) => updates.push(update));

    // Make runPipeline trigger the heartbeat callback
    mockRunPipeline.mockImplementation(async (config: any) => {
      if (config.onAgentHeartbeat) {
        config.onAgentHeartbeat(5000);
        config.onAgentHeartbeat(10000);
      }
    });

    await tool.execute('call-5', { taskJsonPath: '/tasks/test.task.json' }, undefined, onUpdate, {} as any);

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(updates[0]).toEqual({
      content: [{ type: 'text', text: '... still running (5s)\n' }],
      details: { taskJsonPath: '/tasks/test.task.json' },
    });
  });

  it('propagates pipeline errors', async () => {
    mockRunPipeline.mockRejectedValue(new Error('Pipeline exploded'));

    await expect(
      tool.execute('call-6', { taskJsonPath: '/tasks/test.task.json' }, undefined, undefined, {} as any),
    ).rejects.toThrow('Pipeline exploded');
  });
});
