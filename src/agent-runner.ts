import { parseAgentResult } from './util/parse-agent-result.js';
import { loadAgentMetadata } from './util/parse-frontmatter.js';
import { createLogger } from './util/logger.js';
import type { AgentMetadata, SpawnAgentOptions, SpawnAgentResult } from './types.js';

const log = createLogger();

/**
 * Spawn a Claude Code session via the CLI with proper harness enforcement.
 *
 * Uses `claude --print` with:
 *   --worktree      git isolation per agent
 *   --allowedTools  from agent .md frontmatter
 *   --output-format stream-json  for structured output parsing
 *   --model         from frontmatter if specified
 */
export async function spawnAgent(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
  const timeout = options.timeout ?? 600_000; // 10 min default
  const start = Date.now();

  const metadata = await loadAgentMetadata(options.caseRoot, options.agentName);

  log.info('spawning agent', {
    agent: options.agentName,
    cwd: options.cwd,
    tools: metadata.tools,
    timeout,
    background: options.background,
  });

  try {
    const raw = await runClaude(options, metadata, timeout);
    const durationMs = Date.now() - start;
    const result = parseAgentResult(raw);

    log.info('agent completed', { agent: options.agentName, durationMs, status: result.status });

    return { raw, result, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);

    log.error('agent spawn failed', { agent: options.agentName, durationMs, error: errorMsg });

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

function buildCliArgs(options: SpawnAgentOptions, metadata: AgentMetadata): string[] {
  const args = ['claude', '--print', '-p', options.prompt, '--output-format', 'stream-json'];

  // Tool restrictions from agent frontmatter
  for (const tool of metadata.tools) {
    args.push('--allowedTools', tool);
  }

  // Git worktree isolation (skip for background/fire-and-forget agents)
  if (!options.background) {
    args.push('--worktree');
  }

  // Model override from frontmatter
  if (metadata.model) {
    args.push('--model', metadata.model);
  }

  return args;
}

async function runClaude(options: SpawnAgentOptions, metadata: AgentMetadata, timeout: number): Promise<string> {
  const args = buildCliArgs(options, metadata);

  const proc = Bun.spawn(args, {
    cwd: options.cwd,
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

  // Parse stream-json output: extract text content from assistant messages
  return extractTextFromStreamJson(stdout);
}

/** Extract text content from stream-json formatted output. */
function extractTextFromStreamJson(raw: string): string {
  const chunks: string[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;

    let event: { type?: string; message?: { content?: Array<{ type: string; text?: string }> } };
    try {
      event = JSON.parse(line);
    } catch {
      // Not JSON — might be plain text output, include as-is
      chunks.push(line);
      continue;
    }

    if (event.type === 'assistant' && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === 'text' && block.text) {
          chunks.push(block.text);
        }
      }
    }
  }

  return chunks.join('');
}
