/**
 * Scout findings schema + synthesis.
 *
 * The scout agent explores the target repo before the implementer runs and
 * returns structured findings via its `AGENT_RESULT` payload (under a
 * `findings` key). This module:
 *
 *   1. Validates the raw object against the {@link ScoutFindings} contract
 *      using hand-rolled checks (the project does not depend on a runtime
 *      schema library — see `src/memory/schema.ts` for the same pattern).
 *   2. Synthesizes a validated `ScoutFindings` into a concise markdown block
 *      that the orchestrator prepends to the implementer's prompt as a
 *      `## Scout Findings` section.
 *
 * Synthesis is a pure function and the primary unit-test target. Validation
 * is intentionally strict on shape but lenient on order — unknown extra
 * fields are stripped, missing optional fields are tolerated, and the
 * synthesizer degrades gracefully when handed an effectively empty findings
 * object.
 */
import type { ScoutFindings } from '../types.js';

export type { ScoutFindings } from '../types.js';

export class ScoutFindingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoutFindingsValidationError';
  }
}

/**
 * Validate `value` as a {@link ScoutFindings}. Returns the typed value on
 * success, throws {@link ScoutFindingsValidationError} with a path-prefixed
 * message on failure. Unknown top-level keys are ignored — the scout may add
 * extra metadata we don't yet consume.
 */
export function validateScoutFindings(value: unknown): ScoutFindings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScoutFindingsValidationError('scout findings must be a JSON object');
  }
  const v = value as Record<string, unknown>;

  const relevantFiles = requireArray(v, 'relevantFiles').map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ScoutFindingsValidationError(`relevantFiles[${i}]: expected object`);
    }
    const e = entry as Record<string, unknown>;
    const path = requireString(e, `relevantFiles[${i}].path`, 'path');
    const reason = requireString(e, `relevantFiles[${i}].reason`, 'reason');
    return { path, reason };
  });

  const patterns = requireArray(v, 'patterns').map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ScoutFindingsValidationError(`patterns[${i}]: expected object`);
    }
    const e = entry as Record<string, unknown>;
    const name = requireString(e, `patterns[${i}].name`, 'name');
    const file = requireString(e, `patterns[${i}].file`, 'file');
    const description = requireString(e, `patterns[${i}].description`, 'description');
    return { name, file, description };
  });

  const constraints = requireStringArray(v, 'constraints');

  const out: ScoutFindings = { relevantFiles, patterns, constraints };

  if (v.testBaseline !== undefined) {
    const tb = v.testBaseline;
    if (typeof tb !== 'object' || tb === null || Array.isArray(tb)) {
      throw new ScoutFindingsValidationError('testBaseline: expected object');
    }
    const t = tb as Record<string, unknown>;
    const command = requireString(t, 'testBaseline.command', 'command');
    const passing = requireNumber(t, 'testBaseline.passing', 'passing');
    const failing = requireNumber(t, 'testBaseline.failing', 'failing');
    const relevant = requireStringArray(t, 'relevant');
    out.testBaseline = { command, passing, failing, relevant };
  }

  if (v.suggestedApproach !== undefined) {
    out.suggestedApproach = requireString(v, 'suggestedApproach');
  }

  return out;
}

/**
 * Parse a raw `findings` value (typically the `findings` key of the scout's
 * `AGENT_RESULT` block) into a validated {@link ScoutFindings}. Returns
 * `null` on any validation failure — the implementer phase treats a `null`
 * result as "no findings" and runs as before (graceful degradation per the
 * spec).
 */
export function parseScoutFindings(raw: unknown): ScoutFindings | null {
  try {
    return validateScoutFindings(raw);
  } catch {
    return null;
  }
}

const EMPTY_MESSAGE = '## Scout Findings\n\n_No scout findings available — proceeding without exploration context._';

/**
 * Synthesize structured scout findings into a markdown section the
 * implementer can consume directly. Sections that have no entries are
 * omitted rather than emitting empty headings, which keeps the prompt
 * compact when only a subset of findings is present.
 *
 * Pure function — no I/O, no validation. Callers should validate first via
 * {@link validateScoutFindings} or {@link parseScoutFindings}.
 */
export function synthesizeForImplementer(findings: ScoutFindings | null | undefined): string {
  if (!findings) return EMPTY_MESSAGE;

  const sections: string[] = [];

  if (findings.relevantFiles.length > 0) {
    const lines = ['### Relevant Files'];
    for (const f of findings.relevantFiles) {
      lines.push(`- \`${f.path}\` — ${f.reason}`);
    }
    sections.push(lines.join('\n'));
  }

  if (findings.patterns.length > 0) {
    const lines = ['### Patterns to Follow'];
    for (const p of findings.patterns) {
      lines.push(`- **${p.name}** in \`${p.file}\` — ${p.description}`);
    }
    sections.push(lines.join('\n'));
  }

  if (findings.testBaseline) {
    const tb = findings.testBaseline;
    const lines = [
      '### Test Baseline',
      `- Command: \`${tb.command}\``,
      `- Passing: ${tb.passing}`,
      `- Failing: ${tb.failing}`,
    ];
    if (tb.relevant.length > 0) {
      lines.push(`- Relevant: ${tb.relevant.map((r) => `\`${r}\``).join(', ')}`);
    }
    sections.push(lines.join('\n'));
  }

  if (findings.constraints.length > 0) {
    const lines = ['### Constraints'];
    for (const c of findings.constraints) {
      lines.push(`- ${c}`);
    }
    sections.push(lines.join('\n'));
  }

  if (findings.suggestedApproach && findings.suggestedApproach.trim().length > 0) {
    sections.push(`### Suggested Approach\n${findings.suggestedApproach.trim()}`);
  }

  if (sections.length === 0) return EMPTY_MESSAGE;

  return ['## Scout Findings', '', ...sections.flatMap((s) => [s, ''])].join('\n').trimEnd();
}

// --- helpers (mirrors the validator style in src/memory/schema.ts) ---

function requireString(obj: Record<string, unknown>, path: string, key?: string): string {
  const k = key ?? path;
  const v = obj[k];
  if (typeof v !== 'string') {
    throw new ScoutFindingsValidationError(`${path}: expected string, got ${describe(v)}`);
  }
  return v;
}

function requireNumber(obj: Record<string, unknown>, path: string, key?: string): number {
  const k = key ?? path;
  const v = obj[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ScoutFindingsValidationError(`${path}: expected number, got ${describe(v)}`);
  }
  return v;
}

function requireArray(obj: Record<string, unknown>, key: string): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new ScoutFindingsValidationError(`${key}: expected array, got ${describe(v)}`);
  }
  return v;
}

function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
  const arr = requireArray(obj, key);
  return arr.map((entry, i) => {
    if (typeof entry !== 'string') {
      throw new ScoutFindingsValidationError(`${key}[${i}]: expected string, got ${describe(entry)}`);
    }
    return entry;
  });
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
