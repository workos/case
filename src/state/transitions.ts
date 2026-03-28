import type { PipelinePhase, PipelineProfile, TaskJson } from '../types.js';
import { PHASE_ORDER, PROFILE_PHASES } from '../types.js';

/**
 * Determine which pipeline phase to enter based on current task state and profile.
 * Encodes the re-entry semantics from SKILL.md Step 0, with profile awareness.
 *
 * If the raw entry phase is skipped by the profile, advances to the next allowed phase.
 */
export function determineEntryPhase(task: TaskJson, profile?: PipelineProfile): PipelinePhase {
  const resolvedProfile = profile ?? task.profile ?? 'standard';
  const allowedPhases = new Set(PROFILE_PHASES[resolvedProfile]);
  const rawPhase = determineRawEntryPhase(task);

  // Terminal phases pass through regardless of profile
  if (rawPhase === 'complete' || rawPhase === 'abort') return rawPhase;

  // If the raw phase is in the profile, use it
  if (allowedPhases.has(rawPhase)) return rawPhase;

  // Otherwise, find the next allowed phase
  return findNextAllowedPhase(rawPhase, allowedPhases) ?? 'implement';
}

/**
 * Raw entry phase determination — same logic as the original determineEntryPhase.
 *
 * Resume status table:
 *   active              -> implement
 *   implementing        -> implement (if implementer not completed), verify (if completed)
 *   verifying           -> verify (if verifier not completed), review (if completed)
 *   reviewing           -> review (if reviewer not completed), close (if completed)
 *   closing             -> close
 *   pr-opened / merged  -> complete
 */
function determineRawEntryPhase(task: TaskJson): PipelinePhase {
  switch (task.status) {
    case 'active':
      return 'implement';

    case 'implementing': {
      const impl = task.agents.implementer;
      if (impl?.status === 'completed') return 'verify';
      return 'implement';
    }

    case 'verifying': {
      const ver = task.agents.verifier;
      if (ver?.status === 'completed') return 'review';
      return 'verify';
    }

    case 'reviewing': {
      const rev = task.agents.reviewer;
      if (rev?.status === 'completed') return 'close';
      return 'review';
    }

    case 'closing':
      return 'close';

    case 'pr-opened':
    case 'merged':
      return 'complete';

    default:
      // Fallback for unknown states
      return 'implement';
  }
}

/** Find the next phase in PHASE_ORDER that is in the allowed set, starting from (and including) the given phase. */
export function findNextAllowedPhase(from: PipelinePhase, allowed: Set<PipelinePhase>): PipelinePhase | undefined {
  const idx = PHASE_ORDER.indexOf(from);
  for (let i = idx + 1; i < PHASE_ORDER.length; i++) {
    if (allowed.has(PHASE_ORDER[i])) return PHASE_ORDER[i];
  }
  return undefined;
}
