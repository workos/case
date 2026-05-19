/**
 * Read/write/merge helpers for `<repoPath>/.case/<task-slug>/working-memory.json`.
 *
 * - `readWorkingMemory(taskDir)` — load + validate, returns `null` on cold start
 *   or on corrupt files (logs a warning to stderr so the corruption is observable
 *   without blocking the pipeline).
 * - `writeWorkingMemory(taskDir, memory)` — schema-validates before writing.
 *   Always stamps a fresh `updatedAt`.
 * - `mergeWorkingMemory(existing, update)` — appends to array fields (deduped by
 *   key column) and replaces scalars. Returns a new object; never mutates.
 *
 * Designed to be safe to call from the CLI `ca update-memory` command and from
 * the orchestrator's pre-phase prompt injection.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateWorkingMemory, WorkingMemoryValidationError, WORKING_MEMORY_VERSION } from './schema.js';
import type { WorkingMemory, WorkingMemoryApproach, WorkingMemoryError, WorkingMemoryUpdate } from '../types.js';

export const WORKING_MEMORY_FILENAME = 'working-memory.json';

/** Resolve the canonical working-memory.json path for a task. */
export function workingMemoryPath(taskDir: string): string {
  return resolve(taskDir, WORKING_MEMORY_FILENAME);
}

/**
 * Read and validate working memory. Returns `null` if the file does not exist
 * (cold start) or if it cannot be parsed/validated — corrupt memory must not
 * fail the pipeline, but the warning is surfaced on stderr for observability.
 */
export function readWorkingMemory(taskDir: string): WorkingMemory | null {
  const path = workingMemoryPath(taskDir);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    process.stderr.write(`[working-memory] read failed: ${(err as Error).message}\n`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[working-memory] JSON parse failed at ${path}: ${(err as Error).message}\n`);
    return null;
  }

  try {
    return validateWorkingMemory(parsed);
  } catch (err) {
    if (err instanceof WorkingMemoryValidationError) {
      process.stderr.write(`[working-memory] validation failed at ${path}: ${err.message}\n`);
      return null;
    }
    throw err;
  }
}

/**
 * Write working memory. Validates before writing and stamps a fresh `updatedAt`
 * — callers can pass any `updatedAt` they want; this function overwrites it so
 * the timestamp always reflects the actual write.
 */
export function writeWorkingMemory(taskDir: string, memory: WorkingMemory): void {
  const stamped: WorkingMemory = { ...memory, updatedAt: new Date().toISOString() };
  validateWorkingMemory(stamped);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(workingMemoryPath(taskDir), JSON.stringify(stamped, null, 2) + '\n');
}

/**
 * Merge an update into an existing snapshot. Arrays are concatenated and
 * de-duplicated by key column (`approach` for approachesTried, `error` for
 * errorsSeen, identity for `filesChanged`/`blockers`). Scalars replace.
 *
 * Returns a new object — never mutates either input.
 */
export function mergeWorkingMemory(existing: WorkingMemory, update: WorkingMemoryUpdate): WorkingMemory {
  return {
    version: WORKING_MEMORY_VERSION,
    updatedAt: existing.updatedAt,
    currentState: update.currentState ?? existing.currentState,
    approach: update.approach ?? existing.approach,
    filesChanged: dedupeStrings([...existing.filesChanged, ...(update.filesChanged ?? [])]),
    errorsSeen: dedupeByKey<WorkingMemoryError>([...existing.errorsSeen, ...(update.errorsSeen ?? [])], (e) => e.error),
    approachesTried: dedupeByKey<WorkingMemoryApproach>(
      [...existing.approachesTried, ...(update.approachesTried ?? [])],
      (a) => a.approach,
    ),
    blockers: dedupeStrings([...existing.blockers, ...(update.blockers ?? [])]),
  };
}

/**
 * Build an empty starting snapshot. Used by the CLI when no prior memory
 * exists — the first `ca update-memory` call creates it from scratch.
 */
export function emptyWorkingMemory(): WorkingMemory {
  return {
    version: WORKING_MEMORY_VERSION,
    updatedAt: new Date().toISOString(),
    currentState: '',
    approach: '',
    filesChanged: [],
    errorsSeen: [],
    approachesTried: [],
    blockers: [],
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function dedupeByKey<T>(values: T[], key: (entry: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const entry of values) {
    // Later entries overwrite earlier — lets an update upgrade a previous
    // record (e.g. an `unresolved` error becomes `fixed`).
    byKey.set(key(entry), entry);
  }
  return Array.from(byKey.values());
}
