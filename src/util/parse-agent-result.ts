import type { AgentResult, Rubric } from '../types.js';

const START_DELIMITER = '<<<AGENT_RESULT';
const END_DELIMITER = 'AGENT_RESULT>>>';

const DEFAULT_ARTIFACTS: AgentResult['artifacts'] = {
  commit: null,
  filesChanged: [],
  testsPassed: null,
  screenshotUrls: [],
  evidenceMarkers: [],
  prUrl: null,
  prNumber: null,
};

/**
 * Extract and validate an AGENT_RESULT JSON block from raw agent output.
 * Uses lastIndexOf for the start delimiter so that if the agent discusses
 * the format before emitting it, the actual result block is used.
 *
 * Never throws — returns a synthetic failed result on parse failure.
 */
export function parseAgentResult(raw: string): AgentResult {
  const startIdx = raw.lastIndexOf(START_DELIMITER);
  if (startIdx === -1) {
    return syntheticFailed('AGENT_RESULT start delimiter not found');
  }

  const afterStart = startIdx + START_DELIMITER.length;
  const endIdx = raw.indexOf(END_DELIMITER, afterStart);
  if (endIdx === -1) {
    return syntheticFailed('AGENT_RESULT end delimiter not found');
  }

  const jsonText = raw.slice(afterStart, endIdx).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return syntheticFailed(`AGENT_RESULT JSON parse error: ${msg}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return syntheticFailed('AGENT_RESULT is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required fields
  if (!obj.status || typeof obj.status !== 'string') {
    return syntheticFailed('AGENT_RESULT missing required field: status');
  }
  if (!['completed', 'failed', 'blocked'].includes(obj.status)) {
    return syntheticFailed(`AGENT_RESULT invalid status: ${obj.status}`);
  }

  const artifacts =
    typeof obj.artifacts === 'object' && obj.artifacts !== null
      ? { ...DEFAULT_ARTIFACTS, ...(obj.artifacts as Record<string, unknown>) }
      : { ...DEFAULT_ARTIFACTS };

  return {
    status: obj.status as AgentResult['status'],
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    artifacts: {
      commit: typeof artifacts.commit === 'string' ? artifacts.commit : null,
      filesChanged: Array.isArray(artifacts.filesChanged) ? (artifacts.filesChanged as string[]) : [],
      testsPassed: typeof artifacts.testsPassed === 'boolean' ? artifacts.testsPassed : null,
      screenshotUrls: Array.isArray(artifacts.screenshotUrls) ? (artifacts.screenshotUrls as string[]) : [],
      evidenceMarkers: Array.isArray(artifacts.evidenceMarkers) ? (artifacts.evidenceMarkers as string[]) : [],
      prUrl: typeof artifacts.prUrl === 'string' ? artifacts.prUrl : null,
      prNumber: typeof artifacts.prNumber === 'number' ? artifacts.prNumber : null,
    },
    findings: obj.findings as AgentResult['findings'],
    rubric: parseRubric(obj.rubric),
    error: typeof obj.error === 'string' ? obj.error : null,
  };
}

function parseRubric(raw: unknown): Rubric | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.role !== 'verifier' && obj.role !== 'reviewer') return undefined;
  if (!Array.isArray(obj.categories)) return undefined;
  return obj as unknown as Rubric;
}

function syntheticFailed(error: string): AgentResult {
  return {
    status: 'failed',
    summary: '',
    artifacts: { ...DEFAULT_ARTIFACTS },
    error,
  };
}
