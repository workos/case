/**
 * Prepare raw tool args or results for the trace log.
 *
 * Goals:
 * - Keep traces useful for debugging (tool name, key args, error messages)
 * - Limit size to prevent trace bloat
 * - Strip secrets / sensitive values before they hit disk
 *
 * @param raw  - The raw value from the Pi agent event (args or result, any shape)
 * @param maxLen - Maximum character length for the returned string (default 500)
 * @returns A truncated, sanitized string representation
 */
const SECRET_PATTERN =
  /(?<=["']?(?:token|key|secret|password|authorization|credential|api_key|apikey|access_token|refresh_token)["']?\s*[:=]\s*["']?)[^"'}{,\n]+/gi;

const TRUNCATION_SUFFIX = '…[truncated]';

export function sanitizeForTrace(raw: unknown, maxLen = 500): string {
  if (raw === undefined || raw === null) return '';

  const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const redacted = str.replace(SECRET_PATTERN, '***');

  if (redacted.length <= maxLen) return redacted;
  return redacted.slice(0, maxLen - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}
