/**
 * Interactive interviewer session for `ca onboard --interview`.
 *
 * Spawns the interviewer agent (`agents/interviewer.md`) in an interactive
 * pi-coding-agent session. The agent explores the target repo read-only,
 * asks the human targeted questions in the terminal, and emits an
 * `AGENT_RESULT` block. This module:
 *
 *   1. Builds the briefing message from the mechanical probe results (and,
 *      for `--re-interview`, the existing `ProjectEntry`).
 *   2. Wires up `createAgentSessionRuntime` with the interviewer's read-only
 *      tool set (`Read` + `Bash`).
 *   3. Captures the agent's final response, parses the `AGENT_RESULT` block,
 *      and validates the `findings` payload via
 *      {@link parseInterviewFindings}.
 *
 * Returns the validated {@link InterviewFindings} on success or `null` if the
 * runtime fails, the human aborts, or the agent emits an unparseable block.
 * The caller (`onboard.ts`) treats `null` as "fall back to mechanical-only".
 *
 * Patterned after `src/agent/orchestrator-session.ts`.
 */
import {
  AuthStorage,
  createAgentSession,
  createAgentSessionRuntime,
  createBashTool,
  createReadTool,
  DefaultResourceLoader,
  getAgentDir,
  InteractiveMode,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type {
  AgentSessionRuntime,
  CreateAgentSessionRuntimeResult,
  ToolDefinition,
} from '@mariozechner/pi-coding-agent';
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

/**
 * Run the interviewer in an interactive session and return validated findings.
 *
 * Returns `null` when the runtime fails to start, the agent returns no
 * parseable result, or the findings fail validation. The caller is
 * responsible for surfacing this as a graceful degradation to mechanical-only.
 */
export async function startInterviewSession(options: InterviewSessionOptions): Promise<InterviewFindings | null> {
  // Suppress structured JSON logs in interactive mode — the TUI provides its own feedback.
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

  // Capture the agent's final response so we can parse the AGENT_RESULT block.
  let responseText = '';

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
      // Read-only tools only — interviewer must never mutate the repo.
      customTools: [createReadTool(factoryOpts.cwd), createBashTool(factoryOpts.cwd)] as unknown as ToolDefinition[],
    });

    // Subscribe to the underlying agent so we capture text deltas for AGENT_RESULT parsing.
    const session = result.session as unknown as {
      subscribe?: (fn: (event: unknown) => void) => void;
    };
    if (typeof session.subscribe === 'function') {
      session.subscribe((event: unknown) => {
        const e = event as {
          type?: string;
          assistantMessageEvent?: { type?: string; delta?: string };
        };
        if (
          e.type === 'message_update' &&
          e.assistantMessageEvent?.type === 'text_delta' &&
          typeof e.assistantMessageEvent.delta === 'string'
        ) {
          responseText += e.assistantMessageEvent.delta;
        }
      });
    }

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

  try {
    const interactive = new InteractiveMode(runtime, {
      modelFallbackMessage: runtime.modelFallbackMessage,
      initialMessage: briefing,
    });
    await interactive.run();
  } catch (err) {
    process.stderr.write(
      `\nInterview session aborted: ${(err as Error).message}\n` + `Falling back to mechanical-only onboarding.\n`,
    );
    return null;
  }

  const result = parseAgentResult(responseText);
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
  return lines.join('\n');
}

/** Minimal banner printed before the TUI starts. */
function printBanner(options: InterviewSessionOptions, briefing: string): void {
  const home = process.env.HOME ?? '';
  const safeBriefing = home ? briefing.replaceAll(home, '~') : briefing;
  const sep = '─'.repeat(52);
  process.stderr.write(
    ['', `case · onboard interview — ${basename(options.repoPath)}`, sep, safeBriefing, sep, ''].join('\n') + '\n',
  );
}
