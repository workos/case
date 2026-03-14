import { describe, it, expect } from 'bun:test';
import { parseAgentResult } from '../util/parse-agent-result.js';

describe('parseAgentResult', () => {
  it('parses a valid AGENT_RESULT with all fields', () => {
    const raw = `Some agent output here...
<<<AGENT_RESULT
{"status":"completed","summary":"Fixed the bug","artifacts":{"commit":"abc123","filesChanged":["src/x.ts"],"testsPassed":true,"screenshotUrls":[],"evidenceMarkers":[".case-tested"],"prUrl":null,"prNumber":null},"error":null}
AGENT_RESULT>>>
Done.`;

    const result = parseAgentResult(raw);
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Fixed the bug');
    expect(result.artifacts.commit).toBe('abc123');
    expect(result.artifacts.filesChanged).toEqual(['src/x.ts']);
    expect(result.artifacts.testsPassed).toBe(true);
    expect(result.artifacts.evidenceMarkers).toEqual(['.case-tested']);
    expect(result.error).toBeNull();
  });

  it('returns synthetic failed when start delimiter is missing', () => {
    const result = parseAgentResult('no delimiters here');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('start delimiter not found');
  });

  it('returns synthetic failed when end delimiter is missing', () => {
    const result = parseAgentResult('<<<AGENT_RESULT\n{"status":"completed"}\nno end');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('end delimiter not found');
  });

  it('returns synthetic failed for malformed JSON', () => {
    const result = parseAgentResult('<<<AGENT_RESULT\n{not json}\nAGENT_RESULT>>>');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('JSON parse error');
  });

  it('uses the last AGENT_RESULT block when multiple exist', () => {
    const raw = `Let me explain the format:
<<<AGENT_RESULT
{"status":"failed","summary":"example","artifacts":{},"error":"this is an example"}
AGENT_RESULT>>>

Now here is the actual result:
<<<AGENT_RESULT
{"status":"completed","summary":"actually done","artifacts":{"commit":"def456","filesChanged":["a.ts"],"testsPassed":true,"screenshotUrls":[],"evidenceMarkers":[],"prUrl":null,"prNumber":null},"error":null}
AGENT_RESULT>>>`;

    const result = parseAgentResult(raw);
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('actually done');
    expect(result.artifacts.commit).toBe('def456');
  });

  it('parses reviewer findings', () => {
    const raw = `<<<AGENT_RESULT
{"status":"blocked","summary":"2 critical findings","artifacts":{"commit":null,"filesChanged":[],"testsPassed":null,"screenshotUrls":[],"evidenceMarkers":[],"prUrl":null,"prNumber":null},"findings":{"critical":2,"warnings":1,"info":0,"details":[{"severity":"critical","principle":"5","message":"Secret in source","file":"src/config.ts","line":42}]},"error":null}
AGENT_RESULT>>>`;

    const result = parseAgentResult(raw);
    expect(result.status).toBe('blocked');
    expect(result.findings?.critical).toBe(2);
    expect(result.findings?.details).toHaveLength(1);
    expect(result.findings?.details[0].file).toBe('src/config.ts');
  });

  it('fills default artifacts when artifacts object is empty', () => {
    const raw = `<<<AGENT_RESULT
{"status":"completed","summary":"done","artifacts":{},"error":null}
AGENT_RESULT>>>`;

    const result = parseAgentResult(raw);
    expect(result.artifacts.commit).toBeNull();
    expect(result.artifacts.filesChanged).toEqual([]);
    expect(result.artifacts.testsPassed).toBeNull();
    expect(result.artifacts.screenshotUrls).toEqual([]);
    expect(result.artifacts.evidenceMarkers).toEqual([]);
    expect(result.artifacts.prUrl).toBeNull();
    expect(result.artifacts.prNumber).toBeNull();
  });

  it('fills default artifacts when artifacts key is missing', () => {
    const raw = `<<<AGENT_RESULT
{"status":"failed","summary":"oops","error":"something broke"}
AGENT_RESULT>>>`;

    const result = parseAgentResult(raw);
    expect(result.status).toBe('failed');
    expect(result.artifacts.filesChanged).toEqual([]);
    expect(result.error).toBe('something broke');
  });

  it('returns synthetic failed when status field is missing', () => {
    const raw = `<<<AGENT_RESULT
{"summary":"no status","artifacts":{},"error":null}
AGENT_RESULT>>>`;

    const result = parseAgentResult(raw);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('missing required field: status');
  });

  it('returns synthetic failed for invalid status value', () => {
    const raw = `<<<AGENT_RESULT
{"status":"unknown","summary":"bad","artifacts":{},"error":null}
AGENT_RESULT>>>`;

    const result = parseAgentResult(raw);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('invalid status');
  });

  it('handles agent discussing AGENT_RESULT format before emitting', () => {
    const raw = `I'll now emit my result using the <<<AGENT_RESULT delimiter format.
The status field should be "completed" or "failed".

Here it is:
<<<AGENT_RESULT
{"status":"completed","summary":"real result","artifacts":{"commit":"999aaa","filesChanged":[],"testsPassed":true,"screenshotUrls":[],"evidenceMarkers":[],"prUrl":null,"prNumber":null},"error":null}
AGENT_RESULT>>>`;

    const result = parseAgentResult(raw);
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('real result');
  });

  it('handles PR artifacts from closer', () => {
    const raw = `<<<AGENT_RESULT
{"status":"completed","summary":"PR created","artifacts":{"commit":null,"filesChanged":[],"testsPassed":null,"screenshotUrls":[],"evidenceMarkers":[],"prUrl":"https://github.com/workos/authkit-nextjs/pull/42","prNumber":42},"error":null}
AGENT_RESULT>>>`;

    const result = parseAgentResult(raw);
    expect(result.artifacts.prUrl).toBe('https://github.com/workos/authkit-nextjs/pull/42');
    expect(result.artifacts.prNumber).toBe(42);
  });
});
