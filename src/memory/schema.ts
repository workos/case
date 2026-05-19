/**
 * Structured working memory schema.
 *
 * Working memory lives at `<repoPath>/.case/<task-slug>/working-memory.json`.
 * It is written by the implementer/verifier agents (via `ca update-memory`)
 * and read by the orchestrator before dispatching each phase, so the next
 * agent inherits context about what was tried, what failed, and what files
 * changed.
 *
 * Versioned for forward-compatibility. `version: 1` is the only accepted
 * version today; future migrations bump the literal and add a translator.
 *
 * The codebase does not depend on a runtime schema library (Zod, etc.),
 * so this module exports hand-rolled validators alongside the TypeScript
 * types. Unknown top-level fields are stripped on write; the validator
 * errors out only on missing/invalid values, never on extras.
 */
import type { WorkingMemory, WorkingMemoryUpdate } from '../types.js';

/** Schema version literal — bump on breaking changes. */
export const WORKING_MEMORY_VERSION = 1 as const;

export type ErrorResolution = 'fixed' | 'workaround' | 'unresolved';
export type ApproachOutcome = 'success' | 'partial' | 'failed';

export const ERROR_RESOLUTIONS: readonly ErrorResolution[] = ['fixed', 'workaround', 'unresolved'];
export const APPROACH_OUTCOMES: readonly ApproachOutcome[] = ['success', 'partial', 'failed'];

/** Re-export the canonical interface from types.ts to keep imports stable. */
export type { WorkingMemory, WorkingMemoryUpdate } from '../types.js';

/**
 * Validate `value` as a `WorkingMemory`. Returns the typed value on success,
 * throws `WorkingMemoryValidationError` with a path-prefixed message on failure.
 */
export function validateWorkingMemory(value: unknown): WorkingMemory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkingMemoryValidationError('working memory must be a JSON object');
  }
  const v = value as Record<string, unknown>;

  if (v.version !== WORKING_MEMORY_VERSION) {
    throw new WorkingMemoryValidationError(
      `version: expected ${WORKING_MEMORY_VERSION}, got ${JSON.stringify(v.version)}`,
    );
  }

  const updatedAt = requireString(v, 'updatedAt');
  if (!isIsoDateTime(updatedAt)) {
    throw new WorkingMemoryValidationError(`updatedAt: expected ISO-8601 datetime, got ${JSON.stringify(updatedAt)}`);
  }

  const currentState = requireString(v, 'currentState');
  const approach = requireString(v, 'approach');
  const filesChanged = requireStringArray(v, 'filesChanged');
  const blockers = requireStringArray(v, 'blockers');

  const errorsSeen = requireArray(v, 'errorsSeen').map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new WorkingMemoryValidationError(`errorsSeen[${i}]: expected object`);
    }
    const e = entry as Record<string, unknown>;
    const error = requireString(e, `errorsSeen[${i}].error`, 'error');
    const file = e.file === undefined ? undefined : requireString(e, `errorsSeen[${i}].file`, 'file');
    const resolution = requireEnum<ErrorResolution>(e, `errorsSeen[${i}].resolution`, 'resolution', ERROR_RESOLUTIONS);
    return file === undefined ? { error, resolution } : { error, file, resolution };
  });

  const approachesTried = requireArray(v, 'approachesTried').map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new WorkingMemoryValidationError(`approachesTried[${i}]: expected object`);
    }
    const a = entry as Record<string, unknown>;
    const approachStr = requireString(a, `approachesTried[${i}].approach`, 'approach');
    const outcome = requireEnum<ApproachOutcome>(a, `approachesTried[${i}].outcome`, 'outcome', APPROACH_OUTCOMES);
    const reason = a.reason === undefined ? undefined : requireString(a, `approachesTried[${i}].reason`, 'reason');
    return reason === undefined ? { approach: approachStr, outcome } : { approach: approachStr, outcome, reason };
  });

  return {
    version: WORKING_MEMORY_VERSION,
    updatedAt,
    currentState,
    approach,
    filesChanged,
    errorsSeen,
    approachesTried,
    blockers,
  };
}

/**
 * Validate a partial update — same checks as `validateWorkingMemory` but
 * every top-level field is optional. Used by the `ca update-memory` CLI
 * before merging into the persisted snapshot.
 */
export function validateWorkingMemoryUpdate(value: unknown): WorkingMemoryUpdate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkingMemoryValidationError('working memory update must be a JSON object');
  }
  const v = value as Record<string, unknown>;
  const out: WorkingMemoryUpdate = {};

  if (v.currentState !== undefined) out.currentState = requireString(v, 'currentState');
  if (v.approach !== undefined) out.approach = requireString(v, 'approach');
  if (v.filesChanged !== undefined) out.filesChanged = requireStringArray(v, 'filesChanged');
  if (v.blockers !== undefined) out.blockers = requireStringArray(v, 'blockers');

  if (v.errorsSeen !== undefined) {
    out.errorsSeen = requireArray(v, 'errorsSeen').map((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new WorkingMemoryValidationError(`errorsSeen[${i}]: expected object`);
      }
      const e = entry as Record<string, unknown>;
      const error = requireString(e, `errorsSeen[${i}].error`, 'error');
      const file = e.file === undefined ? undefined : requireString(e, `errorsSeen[${i}].file`, 'file');
      const resolution = requireEnum<ErrorResolution>(
        e,
        `errorsSeen[${i}].resolution`,
        'resolution',
        ERROR_RESOLUTIONS,
      );
      return file === undefined ? { error, resolution } : { error, file, resolution };
    });
  }

  if (v.approachesTried !== undefined) {
    out.approachesTried = requireArray(v, 'approachesTried').map((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new WorkingMemoryValidationError(`approachesTried[${i}]: expected object`);
      }
      const a = entry as Record<string, unknown>;
      const approachStr = requireString(a, `approachesTried[${i}].approach`, 'approach');
      const outcome = requireEnum<ApproachOutcome>(a, `approachesTried[${i}].outcome`, 'outcome', APPROACH_OUTCOMES);
      const reason = a.reason === undefined ? undefined : requireString(a, `approachesTried[${i}].reason`, 'reason');
      return reason === undefined ? { approach: approachStr, outcome } : { approach: approachStr, outcome, reason };
    });
  }

  return out;
}

export class WorkingMemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkingMemoryValidationError';
  }
}

function requireString(obj: Record<string, unknown>, path: string, key?: string): string {
  const k = key ?? path;
  const v = obj[k];
  if (typeof v !== 'string') {
    throw new WorkingMemoryValidationError(`${path}: expected string, got ${describe(v)}`);
  }
  return v;
}

function requireArray(obj: Record<string, unknown>, key: string): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new WorkingMemoryValidationError(`${key}: expected array, got ${describe(v)}`);
  }
  return v;
}

function requireStringArray(obj: Record<string, unknown>, key: string): string[] {
  const arr = requireArray(obj, key);
  return arr.map((entry, i) => {
    if (typeof entry !== 'string') {
      throw new WorkingMemoryValidationError(`${key}[${i}]: expected string, got ${describe(entry)}`);
    }
    return entry;
  });
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  allowed: readonly T[],
): T {
  const v = obj[key];
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new WorkingMemoryValidationError(`${path}: expected one of ${allowed.join('|')}, got ${describe(v)}`);
  }
  return v as T;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Pragmatic ISO-8601 datetime check — accepts the output of `new Date().toISOString()`. */
function isIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts);
}
