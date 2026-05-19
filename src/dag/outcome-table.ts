import type { OutcomeAction, OutcomeKind, PhaseName, PhaseOutcomeKey } from '../types.js';

/**
 * Unified stop-condition failure matrix.
 *
 * Maps every applicable `(phase, outcome)` pair to a concrete next-action. The
 * companion document `docs/failure-matrix.md` is the human-readable view of
 * this same data. Both must be kept in sync — exhaustiveness tests in
 * `src/__tests__/outcome-table.spec.ts` assert that every applicable pair has
 * an entry and that the lookup throws on unknown keys (no `default`
 * fallthrough).
 *
 * Pattern mirrors `src/state/transitions.ts` (status → phase) but at the
 * phase-outcome level instead of the task-status level.
 */

/** Thrown by `resolveOutcome` when no matrix entry exists for the given key. */
export class UnknownOutcomeError extends Error {
  readonly phase: PhaseName;
  readonly outcome: OutcomeKind;

  constructor(phase: PhaseName, outcome: OutcomeKind) {
    super(`No matrix entry for ${phase}:${outcome}`);
    this.name = 'UnknownOutcomeError';
    this.phase = phase;
    this.outcome = outcome;
  }
}

/**
 * Subset of `OutcomeKind` values that may actually be surfaced by each phase.
 * Used by exhaustiveness tests to skip non-applicable combinations
 * (e.g. `fail-github-unreachable` only makes sense for `close`).
 */
const APPLICABLE_OUTCOMES: Record<PhaseName, readonly OutcomeKind[]> = {
  scout: ['success', 'fail-timeout', 'fail-agent-protocol', 'abort-user'],
  implement: [
    'success',
    'fail-test',
    'fail-type-error',
    'fail-lint',
    'fail-build',
    'fail-timeout',
    'fail-agent-protocol',
    'fail-no-code-changes',
    'abort-user',
  ],
  verify: [
    'success',
    'fail-test',
    'fail-evidence-missing',
    'fail-timeout',
    'fail-agent-protocol',
    'fail-soft-findings',
    'abort-user',
  ],
  review: [
    'success',
    'fail-critical-findings',
    'fail-soft-findings',
    'fail-timeout',
    'fail-agent-protocol',
    'budget-exhausted',
    'abort-user',
  ],
  close: ['success', 'fail-github-unreachable', 'fail-agent-protocol', 'fail-timeout', 'abort-user'],
  retrospective: ['success', 'fail-timeout', 'fail-agent-protocol'],
} as const;

/** Return the outcomes that may apply to a given phase. */
export function applicableOutcomes(phase: PhaseName): readonly OutcomeKind[] {
  return APPLICABLE_OUTCOMES[phase];
}

/** All phases that participate in the matrix, in canonical pipeline order. */
export const ALL_PHASES: readonly PhaseName[] = [
  'scout',
  'implement',
  'verify',
  'review',
  'close',
  'retrospective',
] as const;

/** All declared outcome kinds (closed union). */
export const ALL_OUTCOMES: readonly OutcomeKind[] = [
  'success',
  'fail-test',
  'fail-type-error',
  'fail-lint',
  'fail-build',
  'fail-timeout',
  'fail-agent-protocol',
  'fail-no-code-changes',
  'fail-critical-findings',
  'fail-soft-findings',
  'fail-github-unreachable',
  'fail-evidence-missing',
  'abort-user',
  'budget-exhausted',
] as const;

const k = (phase: PhaseName, outcome: OutcomeKind): PhaseOutcomeKey => `${phase}:${outcome}`;

/**
 * The matrix itself. Every applicable `(phase, outcome)` pair must have an
 * entry — exhaustiveness tests enforce this at CI time. Any combination not
 * present here will throw `UnknownOutcomeError` at lookup time.
 */
const MATRIX = new Map<PhaseOutcomeKey, OutcomeAction>([
  // ---- scout ----
  // Scout is advisory: every failure mode routes the executor to the
  // implementer with a warning rather than aborting. The executor models
  // this as `skip-to: implement` so the surface stays consistent with the
  // other `skip-to` entries (revision-budget-exhausted, retrospective
  // failures).
  [k('scout', 'success'), { action: 'advance', to: 'implement' }],
  [
    k('scout', 'fail-timeout'),
    {
      action: 'skip-to',
      to: 'implement',
      withWarning: 'scout timed out; implementer will run without scout findings',
    },
  ],
  [
    k('scout', 'fail-agent-protocol'),
    {
      action: 'skip-to',
      to: 'implement',
      withWarning: 'scout returned malformed AGENT_RESULT; implementer will run without scout findings',
    },
  ],
  [k('scout', 'abort-user'), { action: 'abort', reason: 'user requested abort' }],

  // ---- implement ----
  [k('implement', 'success'), { action: 'advance', to: 'verify' }],
  [k('implement', 'fail-test'), { action: 'retry', maxAttempts: 1 }],
  [k('implement', 'fail-type-error'), { action: 'retry', maxAttempts: 1 }],
  [k('implement', 'fail-lint'), { action: 'retry', maxAttempts: 1 }],
  [k('implement', 'fail-build'), { action: 'retry', maxAttempts: 1 }],
  [k('implement', 'fail-timeout'), { action: 'abort', reason: 'implementer timed out' }],
  [k('implement', 'fail-agent-protocol'), { action: 'abort', reason: 'implementer returned malformed AGENT_RESULT' }],
  [
    k('implement', 'fail-no-code-changes'),
    { action: 'abort', reason: 'implementer produced no code changes; nothing to verify' },
  ],
  [k('implement', 'abort-user'), { action: 'abort', reason: 'user requested abort' }],

  // ---- verify ----
  [k('verify', 'success'), { action: 'advance', to: 'review' }],
  [k('verify', 'fail-test'), { action: 'revision', cycle: 'next' }],
  [k('verify', 'fail-evidence-missing'), { action: 'revision', cycle: 'next' }],
  [k('verify', 'fail-soft-findings'), { action: 'revision', cycle: 'next' }],
  [k('verify', 'fail-timeout'), { action: 'abort', reason: 'verifier timed out' }],
  [k('verify', 'fail-agent-protocol'), { action: 'abort', reason: 'verifier returned malformed AGENT_RESULT' }],
  [k('verify', 'abort-user'), { action: 'abort', reason: 'user requested abort' }],

  // ---- review ----
  [k('review', 'success'), { action: 'advance', to: 'close' }],
  [k('review', 'fail-critical-findings'), { action: 'abort', reason: 'reviewer flagged critical findings' }],
  [k('review', 'fail-soft-findings'), { action: 'revision', cycle: 'next' }],
  // `budget-exhausted` covers both true cycle-budget exhaustion *and* the
  // failure-fingerprint match short-circuit added in Phase 2 (see
  // `src/dag/fingerprint.ts`). The executor emits a more specific
  // notifier/event message at runtime; this matrix entry routes both cases
  // through the same skip-to-close path.
  [
    k('review', 'budget-exhausted'),
    {
      action: 'skip-to',
      to: 'close',
      withWarning:
        'revision budget exhausted (or identical failure fingerprint across cycles); closing with reviewer warnings',
    },
  ],
  [k('review', 'fail-timeout'), { action: 'abort', reason: 'reviewer timed out' }],
  [k('review', 'fail-agent-protocol'), { action: 'abort', reason: 'reviewer returned malformed AGENT_RESULT' }],
  [k('review', 'abort-user'), { action: 'abort', reason: 'user requested abort' }],

  // ---- close ----
  [k('close', 'success'), { action: 'advance', to: 'retrospective' }],
  [k('close', 'fail-github-unreachable'), { action: 'retry', maxAttempts: 1 }],
  [
    k('close', 'fail-agent-protocol'),
    { action: 'surface', message: 'closer returned malformed AGENT_RESULT; manual PR may be required' },
  ],
  [
    k('close', 'fail-timeout'),
    { action: 'surface', message: 'closer timed out; PR may be partially created — verify manually' },
  ],
  [k('close', 'abort-user'), { action: 'abort', reason: 'user requested abort' }],

  // ---- retrospective (never blocks the pipeline) ----
  [k('retrospective', 'success'), { action: 'advance', to: 'complete' }],
  [
    k('retrospective', 'fail-timeout'),
    {
      action: 'skip-to',
      to: 'complete',
      withWarning: 'retrospective timed out; pipeline complete without learnings update',
    },
  ],
  [
    k('retrospective', 'fail-agent-protocol'),
    {
      action: 'skip-to',
      to: 'complete',
      withWarning: 'retrospective returned malformed AGENT_RESULT; pipeline complete without learnings update',
    },
  ],
]);

/**
 * Look up the next action for a `(phase, outcome)` pair.
 *
 * Throws `UnknownOutcomeError` when the pair has no matrix entry — there is
 * no `default` fallthrough by design. The exhaustiveness tests ensure that
 * every pair returned by `applicableOutcomes(phase)` resolves cleanly.
 */
export function resolveOutcome(phase: PhaseName, outcome: OutcomeKind): OutcomeAction {
  const entry = MATRIX.get(k(phase, outcome));
  if (!entry) throw new UnknownOutcomeError(phase, outcome);
  return entry;
}

/**
 * Test-only helper: returns every populated key in the matrix. Lets tests
 * detect entries that exist but should not (i.e. non-applicable pairs).
 */
export function listMatrixKeys(): readonly PhaseOutcomeKey[] {
  return [...MATRIX.keys()];
}
