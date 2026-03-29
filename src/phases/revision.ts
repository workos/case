import type { RubricCategory, RevisionRequest } from '../types.js';

/** Build a RevisionRequest from failed rubric categories. Cycle is set to 0 — pipeline overwrites it. */
export function buildRevisionRequest(
  source: RevisionRequest['source'],
  failedCategories: RubricCategory[],
): RevisionRequest {
  return {
    source,
    failedCategories,
    summary: `${source[0].toUpperCase()}${source.slice(1)} found ${failedCategories.length} issue(s): ${failedCategories.map((f) => f.category).join(', ')}`,
    suggestedFocus: failedCategories.map((f) => f.detail),
    cycle: 0,
  };
}
