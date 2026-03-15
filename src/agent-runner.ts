import { parseAgentResult } from './util/parse-agent-result.js';
import { loadAgentMetadata } from './util/parse-frontmatter.js';
import { createLogger } from './util/logger.js';
import type { AgentMetadata, SpawnAgentOptions, SpawnAgentResult } from './types.js';

const log = createLogger();

/**
 * Spawn a Claude Code session via the CLI with proper harness enforcement.
 *
 * Uses `claude --print` with:
 *   --allowedTools       from agent .md frontmatter
 *   --output-format json single JSON result
 *   --model              from frontmatter if specified
 *   --permission-mode    bypassPermissions (non-interactive)
 *
 * Prompt is piped via stdin to avoid CLI arg length limits.
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

function buildCliArgs(metadata: AgentMetadata): string[] {
  const args = [
    'claude',
    '--print',
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--allowedTools',
    metadata.tools.join(','),
  ];

  if (metadata.model) {
    args.push('--model', metadata.model);
  }

  return args;
}

async function runClaude(options: SpawnAgentOptions, metadata: AgentMetadata, timeout: number): Promise<string> {
  const args = buildCliArgs(metadata);

  // Pipe prompt via stdin to avoid CLI arg length limits
  const proc = Bun.spawn(args, {
    cwd: options.cwd,
    stdin: new Response(options.prompt),
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

  return extractTextFromOutput(stdout);
}

/** Extract assistant text from JSON output format. */
function extractTextFromOutput(raw: string): string {
  // --output-format json returns a single JSON object with a result field
  try {
    const parsed = JSON.parse(raw) as {
      result?: string;
      content?: Array<{ type: string; text?: string }>;
    };

    // Format: { result: "text content" }
    if (typeof parsed.result === 'string') {
      return parsed.result;
    }

    // Format: { content: [{ type: "text", text: "..." }] }
    if (Array.isArray(parsed.content)) {
      return parsed.content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text!)
        .join('');
    }
  } catch {
    // Not valid JSON — return raw text (plain --print output)
  }

  return raw;
}
