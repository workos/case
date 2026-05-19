import { createHash } from 'node:crypto';

/**
 * Input shape for fingerprint computation. Sourced from the structured
 * `RevisionRequest` produced by the evaluator pair (verifier + reviewer) at the
 * end of each cycle.
 */
export interface FingerprintInput {
  /** Names of failed rubric categories (e.g. "reproduced-scenario"). Order-insensitive. */
  failedCategories: string[];
  /** Human-readable error summary. Normalized via trim + lowercase. */
  errorSummary: string;
}

/**
 * Length (hex chars) of the truncated SHA-256 fingerprint. 16 hex chars = 64
 * bits — sufficient for the small number of comparisons we do per run while
 * staying readable in logs.
 */
export const FINGERPRINT_LENGTH = 16;

/**
 * Compute a stable fingerprint for a cycle's failure signature.
 *
 * - Sorts `failedCategories` so identical sets in different orders hash the same.
 * - Normalizes `errorSummary` via `trim().toLowerCase()` so whitespace and case
 *   variation don't cause false negatives.
 * - Truncates to 16 hex chars (64 bits) — collision probability is negligible
 *   for <100 comparisons per run.
 *
 * Pure function with no side effects. Storage of fingerprints lives in the
 * executor.
 */
export function computeFingerprint(input: FingerprintInput): string {
  const categories = [...input.failedCategories].sort().join(':');
  const summary = input.errorSummary.trim().toLowerCase();
  const normalized = `${categories}|${summary}`;
  return createHash('sha256').update(normalized).digest('hex').slice(0, FINGERPRINT_LENGTH);
}

/**
 * Compare two fingerprints. A match means the evaluator pair surfaced the same
 * failure signature across consecutive cycles, so a further revision is
 * unlikely to make progress.
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  return a === b;
}
