import { parseAgentResult } from './util/parse-agent-result.js';
import { createLogger } from './util/logger.js';
import type { SpawnAgentOptions, SpawnAgentResult } from './types.js';

const log = createLogger();

/**
 * Spawn a Claude Code session via the SDK, stream output, and parse AGENT_RESULT.
 *
 * Falls back to CLI with --print if SDK is unavailable.
 */
export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const timeout = options.timeout ?? 600_000; // 10 min default
  const start = Date.now();

  log.info('spawning agent', { cwd: options.cwd, timeout, background: options.background });

  try {
    const raw = await spawnViaSDK(options.prompt, options.cwd, timeout);
    const durationMs = Date.now() - start;
    const result = parseAgentResult(raw);

    log.info('agent completed', { durationMs, status: result.status });

    return { raw, result, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);

    log.error('agent spawn failed', { durationMs, error: errorMsg });

    return {
      raw: '',
      result: {
        status: 'failed',
        summary: '',
        artifacts: {
          commit: null,
          filesChanged: [],
          testsPassed: null,
          screenshotUrls: [],
          evidenceMarkers: [],
          prUrl: null,
          prNumber: null,
        },
        error: `Agent spawn error: ${errorMsg}`,
      },
      durationMs,
    };
  }
}

async function spawnViaSDK(prompt: string, cwd: string, timeout: number): Promise<string> {
  // Dynamic import so the module can load even when SDK isn't installed
  // (tests mock this function)
  let sdk: typeof import('@anthropic-ai/claude-agent-sdk');
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    return spawnViaCLI(prompt, cwd, timeout);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const chunks: string[] = [];

    for await (const event of sdk.query({
      prompt,
      options: {
        cwd,
        allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
        abortController: controller,
      },
    })) {
      // SDKAssistantMessage has message.content with text blocks
      if (event.type === 'assistant' && 'message' in event) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            chunks.push(block.text);
          }
        }
      }
    }

    return chunks.join('');
  } finally {
    clearTimeout(timer);
  }
}

async function spawnViaCLI(prompt: string, cwd: string, timeout: number): Promise<string> {
  const proc = Bun.spawn(['claude', '--print', '-p', prompt], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timer = setTimeout(() => proc.kill(), timeout);
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  return stdout;
}
