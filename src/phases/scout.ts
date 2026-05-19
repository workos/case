import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentResult, PhaseOutcome, PhaseOutput, PipelineConfig, ScoutFindings, TaskJson } from '../types.js';
import { resolveEvidenceStrategy } from '../types.js';
import type { TaskStore } from '../state/task-store.js';
import { spawnAgent } from '../agent/pi-runner.js';
import { readPackageAsset } from '../package-assets.js';
import { parseScoutFindings } from '../scout/findings.js';
import { createLogger } from '../util/logger.js';

const log = createLogger();

/** Default scout time budget (3 minutes). Configurable via `CASE_SCOUT_TIMEOUT_MS`. */
const DEFAULT_SCOUT_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Result envelope for the scout phase.
 *
 * The `findings` field is the canonical handoff between scout and the
 * implementer — parsed and validated via `parseScoutFindings`. When `null`,
 * the implementer is expected to proceed without scout context (graceful
 * degradation per the spec).
 */
export interface ScoutPhaseOutput extends PhaseOutput {
  findings: ScoutFindings | null;
}

/**
 * Run the scout phase.
 *
 * The scout is a read-only exploration agent that runs once per pipeline,
 * before `implement_0`. It returns structured findings (relevant files,
 * patterns, test baseline, constraints) that the orchestrator synthesizes
 * into the implementer's prompt as a `## Scout Findings` section.
 *
 * Failure is non-blocking: a malformed or absent findings payload yields
 * `findings: null` and the executor advances to implement anyway. The
 * implementer's prompt builder degrades gracefully when no findings are
 * present.
 */
export async function runScoutPhase(config: PipelineConfig, store: TaskStore): Promise<ScoutPhaseOutput> {
  log.phase('scout', 'started');

  if (config.dryRun) {
    log.phase('scout', 'dry-run-skip');
    return {
      result: {
        status: 'completed',
        summary: '[dry-run] scout phase skipped',
        artifacts: emptyArtifacts(),
        error: null,
      },
      nextPhase: 'implement',
      outcome: { phase: 'scout', outcome: 'success', details: 'dry-run' },
      findings: null,
    };
  }

  const task = await store.read();
  const prompt = await buildScoutPrompt(config, task);
  const timeoutMs = scoutTimeoutMs();

  const spawn = config.runtime?.spawn.bind(config.runtime) ?? spawnAgent;
  const { raw, result } = await spawn({
    prompt,
    cwd: config.repoPath,
    agentName: 'scout',
    packageRoot: config.packageRoot,
    dataDir: config.dataDir,
    timeout: timeoutMs,
    onHeartbeat: config.onAgentHeartbeat,
    onToolActivity: config.onToolActivity,
    traceWriter: config.traceWriter,
    eventAppender: config.eventAppender,
    phase: 'scout',
  });

  // Scout may emit `findings` either as the top-level `result.findings` field
  // (parsed by the shared AGENT_RESULT helper) or as a `scoutFindings` key
  // alongside the result envelope. Try both — whichever validates wins.
  const findings = extractFindings(raw, result);

  if (result.status !== 'completed') {
    log.phase('scout', 'failed-non-blocking', { error: result.error });
    return {
      result,
      nextPhase: 'implement',
      outcome: classifyScoutAgentFailure(result),
      findings: null,
    };
  }

  if (!findings) {
    log.phase('scout', 'completed-without-findings');
    return {
      result,
      nextPhase: 'implement',
      outcome: { phase: 'scout', outcome: 'fail-agent-protocol', details: 'no validated findings in AGENT_RESULT' },
      findings: null,
    };
  }

  log.phase('scout', 'completed', {
    relevantFiles: findings.relevantFiles.length,
    patterns: findings.patterns.length,
  });
  return {
    result,
    nextPhase: 'implement',
    outcome: { phase: 'scout', outcome: 'success' },
    findings,
  };
}

/**
 * Translate a hard scout-agent failure into a typed outcome. Scout failures
 * are non-blocking (the matrix routes everything except `success` to
 * `skip-to: implement` with a warning), so the classification is for audit
 * fidelity rather than control flow.
 */
function classifyScoutAgentFailure(result: AgentResult): PhaseOutcome {
  const err = (result.error ?? '').toLowerCase();
  if (err.includes('timeout') || err.includes('timed out') || err.includes('aborted')) {
    return { phase: 'scout', outcome: 'fail-timeout', details: result.error ?? undefined };
  }
  return { phase: 'scout', outcome: 'fail-agent-protocol', details: result.error ?? undefined };
}

/**
 * Pull scout findings out of the agent's raw response. Tries (in order):
 *
 *   1. `result.findings` — what the shared AGENT_RESULT parser casts into
 *      `ReviewFindings`. Scout output happens to share the field name, so
 *      we re-validate it against the scout schema and accept on success.
 *   2. A `scoutFindings` key at the top of the AGENT_RESULT JSON — fallback
 *      so the scout can disambiguate its findings from reviewer findings if
 *      a future change adds both to a single envelope.
 *
 * Returns `null` when neither candidate validates — the implementer phase
 * treats `null` as "no findings".
 */
function extractFindings(raw: string, result: AgentResult): ScoutFindings | null {
  const fromResultField = parseScoutFindings(result.findings);
  if (fromResultField) return fromResultField;

  const block = extractAgentResultBlock(raw);
  if (!block) return null;
  return parseScoutFindings(block.scoutFindings);
}

function extractAgentResultBlock(raw: string): Record<string, unknown> | null {
  const startIdx = raw.lastIndexOf('<<<AGENT_RESULT');
  if (startIdx === -1) return null;
  const afterStart = startIdx + '<<<AGENT_RESULT'.length;
  const endIdx = raw.indexOf('AGENT_RESULT>>>', afterStart);
  if (endIdx === -1) return null;
  try {
    const obj = JSON.parse(raw.slice(afterStart, endIdx).trim());
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Build the scout's prompt: the package-asset template plus a minimal Task
 * Context block. The scout is intentionally lean — it should not inherit the
 * implementer's working memory or revision context, since it runs first and
 * has its own read-only mandate.
 */
async function buildScoutPrompt(config: PipelineConfig, task: TaskJson): Promise<string> {
  const template = await readScoutTemplate(config.packageRoot);
  const context = buildScoutContextBlock(config, task);
  return `${template}\n\n${context}`;
}

async function readScoutTemplate(packageRoot: string): Promise<string> {
  try {
    return await readPackageAsset('agents/scout.md', { packageRoot });
  } catch {
    // Mirror the assembler's behaviour: fall back to a literal file read in
    // dev where assets may not yet be registered as package assets.
    const path = resolve(packageRoot, 'agents/scout.md');
    if (!existsSync(path)) {
      throw new Error(`agents/scout.md not found under ${packageRoot}`);
    }
    return readFile(path, 'utf8');
  }
}

function buildScoutContextBlock(config: PipelineConfig, task: TaskJson): string {
  const lines: string[] = ['## Task Context', ''];
  lines.push(`- **Task file**: \`${config.taskMdPath}\``);
  lines.push(`- **Task JSON**: \`${config.taskJsonPath}\``);
  lines.push(`- **Target repo**: \`${config.repoPath}\``);
  lines.push(`- **Repo name**: ${config.repoName}`);
  if (config.project) {
    lines.push(`- **Evidence strategy**: \`${resolveEvidenceStrategy(config.project)}\``);
    lines.push(`- **Package manager**: ${config.project.packageManager}`);
  }
  if (task.issue) {
    lines.push(`- **Issue**: ${task.issueType ?? 'unknown'} ${task.issue}`);
  }
  if (task.fastTestCommand) {
    lines.push(`- **Fast test command**: \`${task.fastTestCommand}\``);
  }
  if (config.project?.commands && Object.keys(config.project.commands).length > 0) {
    lines.push('', '### Project Commands', '');
    for (const [name, command] of Object.entries(config.project.commands)) {
      lines.push(`- **${name}**: \`${command}\``);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function scoutTimeoutMs(): number {
  const raw = process.env.CASE_SCOUT_TIMEOUT_MS;
  if (!raw) return DEFAULT_SCOUT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SCOUT_TIMEOUT_MS;
}

function emptyArtifacts(): AgentResult['artifacts'] {
  return {
    commit: null,
    filesChanged: [],
    testsPassed: null,
    screenshotUrls: [],
    evidenceMarkers: [],
    prUrl: null,
    prNumber: null,
  };
}
