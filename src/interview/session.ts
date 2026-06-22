/**
 * Interactive interviewer session for `ca onboard --interview`.
 *
 * Runs the interviewer agent inside pi-coding-agent's InteractiveMode TUI so
 * the human gets a full interactive editor for free-form answers. The agent
 * explores the target repo read-only, asks questions in the conversation, and
 * emits an `AGENT_RESULT` block. This module:
 *
 *   1. Builds the briefing message from the mechanical probe results (and,
 *      for `--re-interview`, the existing `ProjectEntry`).
 *   2. Wires up `createAgentSessionRuntime` with the interviewer's read-only
 *      tool set (`Read` + `Bash`).
 *   3. Subscribes to session events to capture the agent's text output.
 *   4. Launches `InteractiveMode.run()` (fire-and-forget — it never returns).
 *   5. When `AGENT_RESULT>>>` is detected in the stream, tears down the TUI,
 *      parses findings, and returns them to the caller.
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
import { basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const AGENT_RESULT_END = 'AGENT_RESULT>>>';

/**
 * Run the interviewer in a TUI session and return validated findings.
 *
 * Uses InteractiveMode for the full TUI experience (editor, markdown
 * rendering, tool output). Subscribes to session events to capture the
 * agent's text stream. When `AGENT_RESULT>>>` is detected, the TUI is
 * torn down and findings are returned to the caller.
 *
 * Returns `null` when the runtime fails to start, the agent returns no
 * parseable result, or the findings fail validation.
 */
export async function startInterviewSession(options: InterviewSessionOptions): Promise<InterviewFindings | null> {
  if (!process.env.CASE_DEBUG) {
    process.env.CASE_QUIET = '1';
  }

  // Run pi fully isolated — no global settings, extensions, packages,
  // statusline, or theme from the user's ~/.pi/agent. Just auth (needed
  // for model access). PI_CODING_AGENT_DIR controls where pi reads
  // config; pointing it at a temp dir gives us a clean slate.
  const realAgentDir = getAgentDir();
  const isolatedAgentDir = `${process.env.TMPDIR ?? '/tmp'}/case-interview-pi-${process.pid}`;
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  process.env.PI_SKIP_VERSION_CHECK = '1';

  // Symlink auth.json so model credentials are available in isolation.
  const { mkdirSync, symlinkSync, existsSync } = await import('node:fs');
  mkdirSync(isolatedAgentDir, { recursive: true });
  const realAuth = `${realAgentDir}/auth.json`;
  const isolatedAuth = `${isolatedAgentDir}/auth.json`;
  if (existsSync(realAuth) && !existsSync(isolatedAuth)) {
    symlinkSync(realAuth, isolatedAuth);
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

  const sessionManager = SessionManager.create(options.repoPath);

  // Accumulates all assistant text across turns for AGENT_RESULT detection.
  let responseText = '';

  const runtimeFactory = async (factoryOpts: {
    cwd: string;
    agentDir: string;
    sessionManager: SessionManager;
  }): Promise<CreateAgentSessionRuntimeResult> => {
    const sm = SettingsManager.create(factoryOpts.cwd, factoryOpts.agentDir);
    sm.setQuietStartup(true);

    // Resolve bundled extensions shipped with case (in node_modules).
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const askUserQuestionPath = resolve(thisDir, '../../node_modules/pi-askuserquestion');

    const rl = new DefaultResourceLoader({
      cwd: factoryOpts.cwd,
      agentDir: factoryOpts.agentDir,
      settingsManager: sm,
      appendSystemPrompt: [systemPrompt],
      additionalExtensionPaths: [askUserQuestionPath],
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

  // Subscribe to the session to capture text deltas. This fires for every
  // turn — including follow-up answers the human types in the TUI editor.
  const session = runtime.session;
  let onResultDetected: (() => void) | null = null;
  const resultPromise = new Promise<string>((resolve) => {
    onResultDetected = () => resolve(responseText);
  });

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
      if (responseText.includes(AGENT_RESULT_END) && onResultDetected) {
        // Give the TUI a moment to finish rendering the final response
        // before we tear it down.
        const cb = onResultDetected;
        onResultDetected = null;
        setTimeout(cb, 500);
      }
    }
  });

  // Launch the TUI. InteractiveMode.run() never returns (it has a while(true)
  // loop), so we fire-and-forget and wait on resultPromise instead.
  const interactive = new InteractiveMode(runtime, {
    modelFallbackMessage: runtime.modelFallbackMessage,
    initialMessage: briefing,
  });
  const runPromise = interactive.run().catch(() => {
    // Expected: stop() tears down the TUI, which may cause getUserInput() to
    // throw. We don't care — we already have our findings.
  });

  // Block until AGENT_RESULT>>> is detected or the user quits (Ctrl-C).
  // If the user quits, runPromise settles (via shutdown/process.exit) before
  // resultPromise, so we race them.
  const exitSentinel = runPromise.then(() => '__EXIT__' as const);
  const winner = await Promise.race([resultPromise, exitSentinel]);

  if (winner === '__EXIT__') {
    // User quit the TUI (Ctrl-C / Ctrl-D). No findings.
    return null;
  }

  // Tear down the TUI and clean up.
  interactive.stop();
  await runtime.dispose();

  const captured = winner;
  if (!captured.includes(AGENT_RESULT_END)) {
    process.stderr.write(
      `\nInterview did not produce an AGENT_RESULT block.\n` + `Falling back to mechanical-only onboarding.\n`,
    );
    return null;
  }

  const result = parseAgentResult(captured);
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
