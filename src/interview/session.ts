/**
 * Interactive interviewer session for `ca onboard --interview`.
 *
 * Uses pi-coding-agent's session API directly (no InteractiveMode TUI) to run
 * a multi-turn conversation loop. The agent explores the target repo, asks the
 * human targeted questions via stdin, and emits an `AGENT_RESULT` block. This
 * module:
 *
 *   1. Builds the briefing message from the mechanical probe results (and,
 *      for `--re-interview`, the existing `ProjectEntry`).
 *   2. Wires up `createAgentSessionRuntime` with the interviewer's read-only
 *      tool set (`Read` + `Bash`).
 *   3. Runs a multi-turn loop: send prompt → read agent response → if the
 *      response contains `AGENT_RESULT>>>`, stop. Otherwise, print the
 *      agent's question and read the human's answer from stdin.
 *   4. Parses the `AGENT_RESULT` block and validates findings via
 *      {@link parseInterviewFindings}.
 *
 * Returns the validated {@link InterviewFindings} on success or `null` if the
 * runtime fails, the human aborts, or the agent emits an unparseable block.
 * The caller (`onboard.ts`) treats `null` as "fall back to mechanical-only".
 */
import {
  AuthStorage,
  createAgentSession,
  createAgentSessionRuntime,
  createBashTool,
  createReadTool,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type {
  AgentSessionRuntime,
  CreateAgentSessionRuntimeResult,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { getModelForAgent } from '../agent/config.js';
import { loadSystemPrompt } from '../agent/prompt-loader.js';
import { parseAgentResult } from '../util/parse-agent-result.js';
import { parseInterviewFindings } from './findings.js';
import type { InterviewFindings, ProjectEntry } from '../types.js';

/** Mechanical probe results passed in by `ca onboard`. */
export interface InterviewSessionDetected {
  name: string;
  path: string;
  remote: string;
  language: string;
  packageManager: string;
  description: string;
  commands: Record<string, string>;
  evidenceStrategy: string;
}

export interface InterviewSessionOptions {
  /** Absolute path to the target repo. The interviewer runs with this as cwd. */
  repoPath: string;
  /** Mechanical probe results from `probeRepo()`. */
  detected: InterviewSessionDetected;
  /** Case package root (used to locate the agent prompt). */
  caseRoot: string;
  /** Optional existing entry — populated for `--re-interview`. */
  existingEntry?: ProjectEntry;
}

const MAX_TURNS = 20;
const AGENT_RESULT_END = 'AGENT_RESULT>>>';

/**
 * Extract text content from the last assistant message in the session state.
 */
function getLastAssistantText(session: { state: { messages: unknown[] } }): string {
  const messages = session.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> };
    if (msg.role !== 'assistant') continue;
    if (!Array.isArray(msg.content)) continue;
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    return parts.join('');
  }
  return '';
}

/**
 * Persistent readline wrapper. A single interface is kept alive across all
 * questions — creating/destroying per-question kills stdin on the second call
 * because `rl.close()` pauses the underlying stream.
 */
class InterviewReadline {
  private rl: ReturnType<typeof createInterface>;
  private closed = false;

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stderr });
    this.rl.on('close', () => {
      this.closed = true;
    });
  }

  ask(prompt: string): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => resolve(answer));
    });
  }

  close(): void {
    if (!this.closed) this.rl.close();
  }
}

/**
 * Run the interviewer in a multi-turn session and return validated findings.
 *
 * Returns `null` when the runtime fails to start, the agent returns no
 * parseable result, or the findings fail validation. The caller is
 * responsible for surfacing this as a graceful degradation to mechanical-only.
 */
export async function startInterviewSession(options: InterviewSessionOptions): Promise<InterviewFindings | null> {
  if (!process.env.CASE_DEBUG) {
    process.env.CASE_QUIET = '1';
  }

  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  const modelOverride = process.env.CASE_MODEL_OVERRIDE;
  const modelConfig = modelOverride
    ? { provider: 'anthropic', model: modelOverride }
    : await getModelForAgent('interviewer');
  const model = modelRegistry.find(modelConfig.provider, modelConfig.model);

  const systemPrompt = await loadSystemPrompt(options.caseRoot, 'interviewer');
  const briefing = buildBriefing(options);

  printBanner(options, briefing);

  const sessionManager = SessionManager.create(options.repoPath);

  const runtimeFactory = async (factoryOpts: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
  }): Promise<CreateAgentSessionRuntimeResult> => {
    const sm = SettingsManager.create(factoryOpts.cwd, factoryOpts.agentDir);
    sm.setQuietStartup(true);

    const rl = new DefaultResourceLoader({
      cwd: factoryOpts.cwd,
      agentDir: factoryOpts.agentDir,
      settingsManager: sm,
      appendSystemPrompt: [systemPrompt],
    });
    await rl.reload();

    const result = await createAgentSession({
      cwd: factoryOpts.cwd,
      agentDir: factoryOpts.agentDir,
      authStorage,
      modelRegistry,
      model: model ?? undefined,
      resourceLoader: rl,
      sessionManager: factoryOpts.sessionManager,
      customTools: [createReadTool(factoryOpts.cwd), createBashTool(factoryOpts.cwd)] as unknown as ToolDefinition[],
    });

    return {
      ...result,
      services: { settingsManager: sm, resourceLoader: rl } as unknown as CreateAgentSessionRuntimeResult['services'],
      diagnostics: [],
    };
  };

  let runtime: AgentSessionRuntime;
  try {
    runtime = await createAgentSessionRuntime(runtimeFactory, {
      cwd: options.repoPath,
      agentDir,
      sessionManager,
    });
  } catch (err) {
    process.stderr.write(
      `\nInterview runtime failed to start: ${(err as Error).message}\n` +
        `Falling back to mechanical-only onboarding. Re-run without --interview to suppress this notice.\n`,
    );
    return null;
  }

  // Bind extensions so tools work, but skip TUI.
  const session = runtime.session;
  await session.bindExtensions({
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      newSession: async (opts?: unknown) => runtime.newSession(opts as any),
      fork: async (entryId: string, forkOpts?: unknown) => {
        const result = await runtime.fork(entryId, forkOpts as any);
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId: string, navOpts?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }) => {
        const result = await session.navigateTree(targetId, navOpts);
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath: string, switchOpts?: unknown) => {
        return runtime.switchSession(sessionPath, switchOpts as any);
      },
      reload: async () => {
        await session.reload();
      },
    },
    onError: (err: { extensionPath: string; error: string }) => {
      if (process.env.CASE_DEBUG) {
        process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
      }
    },
  });

  let allResponseText = '';
  const rl = new InterviewReadline();

  try {
    // First turn: send the briefing. The agent explores the repo and may ask
    // its first question, or emit the AGENT_RESULT right away.
    process.stderr.write('\nStarting interview...\n\n');
    await session.prompt(briefing);

    let lastText = getLastAssistantText(session as any);
    allResponseText += lastText;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (allResponseText.includes(AGENT_RESULT_END)) break;

      // The agent asked a question. Print it and get the human's answer.
      process.stderr.write(`\n${lastText}\n`);
      const answer = await rl.ask('\n> ');
      if (answer === null) {
        process.stderr.write('\nInterview aborted by user.\n');
        rl.close();
        await runtime.dispose();
        return null;
      }

      await session.prompt(answer);
      lastText = getLastAssistantText(session as any);
      allResponseText += lastText;
    }
  } catch (err) {
    process.stderr.write(
      `\nInterview session error: ${(err as Error).message}\n` + `Falling back to mechanical-only onboarding.\n`,
    );
    rl.close();
    await runtime.dispose();
    return null;
  }

  rl.close();
  await runtime.dispose();

  if (!allResponseText.includes(AGENT_RESULT_END)) {
    process.stderr.write(
      `\nInterview did not produce an AGENT_RESULT block after ${MAX_TURNS} turns.\n` +
        `Falling back to mechanical-only onboarding.\n`,
    );
    return null;
  }

  const result = parseAgentResult(allResponseText);
  if (result.status !== 'completed') {
    process.stderr.write(
      `\nInterview did not complete successfully${result.error ? `: ${result.error}` : ''}.\n` +
        `Falling back to mechanical-only onboarding.\n`,
    );
    return null;
  }

  const findings = parseInterviewFindings(result.findings);
  if (!findings) {
    process.stderr.write(
      `\nInterview findings could not be validated.\n` + `Falling back to mechanical-only onboarding.\n`,
    );
    return null;
  }

  process.stderr.write('\nInterview complete.\n');
  return findings;
}

/** Build the initial briefing message handed to the interviewer agent. */
function buildBriefing(options: InterviewSessionOptions): string {
  const { repoPath, detected, existingEntry } = options;
  const lines: string[] = [];
  lines.push(`# Onboarding interview brief`);
  lines.push('');
  lines.push(`Target repo: ${detected.name}`);
  lines.push(`Path: ${repoPath}`);
  lines.push(`Remote: ${detected.remote}`);
  lines.push(`Language: ${detected.language}`);
  lines.push(`Package manager: ${detected.packageManager}`);
  lines.push(`Mechanical evidence guess: ${detected.evidenceStrategy}`);
  if (detected.description) {
    lines.push(`Description (from package manifest): ${detected.description}`);
  }
  lines.push('');
  lines.push('Detected commands:');
  for (const [key, value] of Object.entries(detected.commands)) {
    lines.push(`  ${key}: ${value}`);
  }

  if (existingEntry) {
    lines.push('');
    lines.push('Existing projects.json entry (re-interview):');
    lines.push(`  evidenceStrategy: ${existingEntry.evidenceStrategy}`);
    if (existingEntry.verificationNotes) {
      lines.push(`  verificationNotes: ${existingEntry.verificationNotes}`);
    }
    if (existingEntry.credentials) {
      lines.push(`  credentials: ${existingEntry.credentials}`);
    }
  }

  lines.push('');
  lines.push('Run the interview workflow as described in your system prompt.');
  lines.push('Stay within the 5-minute budget and emit the AGENT_RESULT block when done.');
  lines.push('');
  lines.push('IMPORTANT: When you need to ask the human a question, end your response with');
  lines.push('the question. The human will reply in the next message. Do NOT use any tool');
  lines.push('to ask questions — just write them as plain text in your response.');
  return lines.join('\n');
}

/** Minimal banner printed before the session starts. */
function printBanner(options: InterviewSessionOptions, briefing: string): void {
  const home = process.env.HOME ?? '';
  const safeBriefing = home ? briefing.replaceAll(home, '~') : briefing;
  const sep = '─'.repeat(52);
  process.stderr.write(
    ['', `case · onboard interview — ${basename(options.repoPath)}`, sep, safeBriefing, sep, ''].join('\n') + '\n',
  );
}
