/**
 * Parse a JSONL string into an array of typed objects.
 * Skips empty lines and malformed entries (logs errors via optional callback).
 */
export function parseJsonLines<T>(content: string, onError?: (line: string, err: unknown) => void): T[] {
  const results: T[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch (err) {
      onError?.(line, err);
    }
  }
  return results;
}
