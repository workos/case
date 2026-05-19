/**
 * Interview findings schema + synthesis.
 *
 * The interviewer agent (see `agents/interviewer.md`) explores a target repo
 * and asks the human targeted questions before `ca onboard --interview`
 * persists results. The agent emits an `InterviewFindings` payload inside its
 * `AGENT_RESULT` block. This module:
 *
 *   1. Validates the raw object against the {@link InterviewFindings} contract
 *      using hand-rolled checks (matches the project convention used in
 *      `src/scout/findings.ts` and `src/memory/schema.ts` — no Zod).
 *   2. Synthesizes a validated `InterviewFindings` into the three downstream
 *      artifacts the onboard command writes:
 *        - merged {@link ProjectEntry} for `projects.json`
 *        - seed markdown for `<repo>/.case/learnings.md`
 *        - seed markdown for `<repo>/CLAUDE.local.md`
 *   3. Validates that the chosen evidence strategy matches the declared repo
 *      type — surfaces warnings for combinations that the verifier is known
 *      to handle poorly (e.g., `ui-screenshot` on an SDK).
 *
 * Synthesis is pure — callers should validate first via
 * {@link parseInterviewFindings} or {@link validateInterviewFindings}.
 */
import type { EvidenceStrategy, InterviewFindings, ProjectEntry, RepoType } from '../types.js';

export type { InterviewFindings, RepoType } from '../types.js';

export class InterviewFindingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterviewFindingsValidationError';
  }
}

const VALID_EVIDENCE_STRATEGIES: readonly EvidenceStrategy[] = ['ui-screenshot', 'scenario-script', 'test-output'];

const VALID_REPO_TYPES: readonly RepoType[] = ['sdk', 'app', 'library', 'cli', 'monorepo'];

/**
 * Validate `value` as {@link InterviewFindings}. Returns the typed value on
 * success, throws {@link InterviewFindingsValidationError} with a
 * path-prefixed message on failure. Unknown top-level keys are ignored — the
 * agent may emit extras we don't yet consume.
 */
export function validateInterviewFindings(value: unknown): InterviewFindings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InterviewFindingsValidationError('interview findings must be a JSON object');
  }
  const v = value as Record<string, unknown>;

  const evidenceStrategy = requireString(v, 'evidenceStrategy');
  if (!VALID_EVIDENCE_STRATEGIES.includes(evidenceStrategy as EvidenceStrategy)) {
    throw new InterviewFindingsValidationError(
      `evidenceStrategy: expected one of ${VALID_EVIDENCE_STRATEGIES.join(', ')}, got "${evidenceStrategy}"`,
    );
  }

  const evidenceRationale = requireString(v, 'evidenceRationale');
  const verificationNotes = requireString(v, 'verificationNotes');
  const description = requireString(v, 'description');

  const repoType = requireString(v, 'repoType');
  if (!VALID_REPO_TYPES.includes(repoType as RepoType)) {
    throw new InterviewFindingsValidationError(
      `repoType: expected one of ${VALID_REPO_TYPES.join(', ')}, got "${repoType}"`,
    );
  }

  const hasExampleApp = requireBoolean(v, 'hasExampleApp');
  const testFramework = requireString(v, 'testFramework');
  const ciProvider = requireString(v, 'ciProvider');

  const commandOverrides = requireStringRecord(v, 'commandOverrides');

  const learnings = requireArray(v, 'learnings').map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InterviewFindingsValidationError(`learnings[${i}]: expected object`);
    }
    const e = entry as Record<string, unknown>;
    const topic = requireString(e, `learnings[${i}].topic`, 'topic');
    const content = requireString(e, `learnings[${i}].content`, 'content');
    return { topic, content };
  });

  const conventions = requireArray(v, 'conventions').map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InterviewFindingsValidationError(`conventions[${i}]: expected object`);
    }
    const e = entry as Record<string, unknown>;
    const rule = requireString(e, `conventions[${i}].rule`, 'rule');
    const reason = requireString(e, `conventions[${i}].reason`, 'reason');
    return { rule, reason };
  });

  const out: InterviewFindings = {
    evidenceStrategy: evidenceStrategy as EvidenceStrategy,
    evidenceRationale,
    verificationNotes,
    description,
    commandOverrides,
    learnings,
    conventions,
    repoType: repoType as RepoType,
    hasExampleApp,
    testFramework,
    ciProvider,
  };

  if (v.credentials !== undefined) {
    if (typeof v.credentials !== 'string') {
      throw new InterviewFindingsValidationError(`credentials: expected string, got ${describe(v.credentials)}`);
    }
    out.credentials = v.credentials;
  }

  return out;
}

/**
 * Parse a raw `findings` value into a validated {@link InterviewFindings}.
 * Returns `null` on any validation failure — onboard treats `null` as "no
 * findings" and falls back to mechanical detection only (graceful degradation
 * per the spec's failure modes table).
 */
export function parseInterviewFindings(raw: unknown): InterviewFindings | null {
  try {
    return validateInterviewFindings(raw);
  } catch {
    return null;
  }
}

/**
 * Result of validating that an evidence strategy makes sense for a repo type.
 * `warnings` is non-empty when the combination is allowed but historically
 * lossy (e.g., `ui-screenshot` for an SDK). Callers should surface warnings
 * but not block on them — the human has already confirmed the choice.
 */
export interface EvidenceStrategyValidation {
  ok: boolean;
  warnings: string[];
}

/**
 * Confirm that `findings.evidenceStrategy` is a reasonable fit for
 * `findings.repoType`. Returns `{ ok: true, warnings: [] }` for clean
 * matches, `{ ok: true, warnings: [...] }` for matches that work but have
 * known sharp edges, and `{ ok: false, warnings: [...] }` only for
 * combinations that are explicitly nonsensical (none today — the matrix is
 * intentionally permissive and the human has the final say).
 */
export function validateEvidenceStrategy(findings: InterviewFindings): EvidenceStrategyValidation {
  const warnings: string[] = [];

  // ui-screenshot on a non-app type is the primary failure mode the interview
  // is designed to prevent — see contract.md problem statement.
  if (findings.evidenceStrategy === 'ui-screenshot') {
    if (findings.repoType === 'sdk' || findings.repoType === 'library') {
      warnings.push(
        `evidenceStrategy "ui-screenshot" on a ${findings.repoType} repo is unusual — the verifier will try to take Playwright screenshots without a UI to render.`,
      );
    }
    if (findings.repoType === 'cli') {
      warnings.push(
        'evidenceStrategy "ui-screenshot" on a cli repo will fail at the verifier step — clis have no UI to screenshot.',
      );
    }
    if (!findings.hasExampleApp && (findings.repoType === 'sdk' || findings.repoType === 'library')) {
      warnings.push('no example app detected — ui-screenshot evidence requires a runnable UI surface.');
    }
  }

  return { ok: true, warnings };
}

/**
 * Minimum mechanical-detection fields the synthesizer needs to merge an
 * `InterviewFindings` into a `ProjectEntry`. Mirrors the local `DetectedRepo`
 * shape in `src/commands/onboard.ts` — declared here to avoid a circular
 * import and to make the synthesis function unit-testable in isolation.
 */
export interface DetectedRepoForSynthesis {
  name: string;
  path: string;
  remote: string;
  language: string;
  packageManager: string;
  description: string;
  commands: Record<string, string>;
  evidenceStrategy: EvidenceStrategy;
}

/**
 * Merge interview findings with mechanical detection into a final
 * {@link ProjectEntry}. Interview findings always win where they are
 * populated — the human has reviewed them. Mechanical detection wins where
 * the interview is silent (most command keys, language, remote, etc.).
 *
 * Specifically:
 *   - `evidenceStrategy`, `description`, `verificationNotes`, `credentials`
 *     come from the interview.
 *   - `commands` start from `detected.commands`; each entry in
 *     `commandOverrides` replaces (or adds) the matching key.
 *   - `name`, `path`, `remote`, `language`, `packageManager` come from
 *     mechanical detection — the human is not asked about these.
 */
export function synthesizeProjectEntry(findings: InterviewFindings, detected: DetectedRepoForSynthesis): ProjectEntry {
  const commands: Record<string, string> = { ...detected.commands };
  for (const [key, value] of Object.entries(findings.commandOverrides)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      commands[key] = value;
    } else if (typeof value === 'string' && value.trim().length === 0) {
      // Empty string = delete the command. Lets the agent remove placeholder
      // scripts (e.g., `echo "Error: no test specified" && exit 1`).
      delete commands[key];
    }
  }

  const entry: ProjectEntry = {
    name: detected.name,
    evidenceStrategy: findings.evidenceStrategy,
    path: detected.path,
    remote: detected.remote,
    description: findings.description.trim().length > 0 ? findings.description : detected.description,
    language: detected.language,
    packageManager: detected.packageManager,
    commands,
    verificationNotes: findings.verificationNotes,
  };

  if (findings.credentials && findings.credentials.trim().length > 0) {
    entry.credentials = findings.credentials;
  }

  return entry;
}

/**
 * Format the interview's learnings array as a `.case/learnings.md`
 * document. Each entry becomes a `## {topic}` heading followed by its
 * content paragraph. Returns the empty string when no learnings were
 * captured — onboard treats that as "skip writing the file".
 */
export function synthesizeLearnings(findings: InterviewFindings): string {
  if (findings.learnings.length === 0) return '';

  const sections: string[] = ['# Repo Learnings', ''];
  for (const entry of findings.learnings) {
    sections.push(`## ${entry.topic}`, '', entry.content.trim(), '');
  }
  return sections.join('\n').trimEnd() + '\n';
}

/**
 * Format the interview's conventions array as `CLAUDE.local.md` content.
 * Each entry becomes a bullet under a `## Conventions` heading, with the
 * reason rendered as italicized rationale. Returns the empty string when
 * no conventions were captured.
 */
export function synthesizeClaudeLocal(findings: InterviewFindings): string {
  if (findings.conventions.length === 0) return '';

  const lines: string[] = ['# CLAUDE.local.md', '', '## Conventions', ''];
  for (const entry of findings.conventions) {
    lines.push(`- **${entry.rule}** — _${entry.reason}_`);
  }
  return lines.join('\n').trimEnd() + '\n';
}

// --- helpers (mirrors the validator style in src/scout/findings.ts) ---

function requireString(obj: Record<string, unknown>, path: string, key?: string): string {
  const k = key ?? path;
  const v = obj[k];
  if (typeof v !== 'string') {
    throw new InterviewFindingsValidationError(`${path}: expected string, got ${describe(v)}`);
  }
  return v;
}

function requireBoolean(obj: Record<string, unknown>, path: string, key?: string): boolean {
  const k = key ?? path;
  const v = obj[k];
  if (typeof v !== 'boolean') {
    throw new InterviewFindingsValidationError(`${path}: expected boolean, got ${describe(v)}`);
  }
  return v;
}

function requireArray(obj: Record<string, unknown>, key: string): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new InterviewFindingsValidationError(`${key}: expected array, got ${describe(v)}`);
  }
  return v;
}

function requireStringRecord(obj: Record<string, unknown>, key: string): Record<string, string> {
  const v = obj[key];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new InterviewFindingsValidationError(`${key}: expected object, got ${describe(v)}`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') {
      throw new InterviewFindingsValidationError(`${key}.${k}: expected string, got ${describe(val)}`);
    }
    out[k] = val;
  }
  return out;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
