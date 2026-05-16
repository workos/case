import type { RevisionRequest } from '../types.js';

export function mergeRevisionRequests(requests: RevisionRequest[]): RevisionRequest {
  if (requests.length === 0) throw new Error('Cannot merge zero revision requests');
  if (requests.length === 1) return requests[0];

  const merged: RevisionRequest = {
    source: 'verifier',
    failedCategories: [],
    summary: '',
    suggestedFocus: [],
    cycle: Math.max(...requests.map((r) => r.cycle)),
  };

  const sources = new Set(requests.map((r) => r.source));
  merged.source = sources.size > 1 ? 'verifier' : requests[0].source;

  const seen = new Set<string>();
  for (const req of requests) {
    for (const cat of req.failedCategories) {
      if (!seen.has(cat.category)) {
        seen.add(cat.category);
        merged.failedCategories.push(cat);
      }
    }
  }

  merged.suggestedFocus = [...new Set(requests.flatMap((r) => r.suggestedFocus))];
  merged.summary = requests.map((r) => `[${r.source}] ${r.summary}`).join('\n');

  return merged;
}
