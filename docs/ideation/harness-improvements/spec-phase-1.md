# Implementation Spec: Harness Improvements - Phase 1

**Contract**: ./contract.md
**Estimated Effort**: S

## Technical Approach

Add a `scripts/parse-test-output.sh` that converts vitest's JSON reporter output into a structured, machine-readable format. Then update `scripts/mark-tested.sh` to call the parser and embed richer evidence in `.case-tested` — pass/fail counts, coverage %, duration, and per-file breakdown.

vitest supports `--reporter=json` natively, which outputs structured results to stdout. The parser script consumes this JSON and extracts the fields agents care about. This replaces the current grep-based heuristic (counting lines matching "pass" or "fail") with exact data.

## Feedback Strategy

**Inner-loop command**: `echo '{"testResults":[{"name":"foo.spec.ts","status":"passed","assertionResults":[{"status":"passed"}]}],"numPassedTests":1,"numFailedTests":0}' | bash scripts/parse-test-output.sh`

**Playground**: Test suite — create a test fixture with sample vitest JSON output, validate parsing.

**Why this approach**: Both scripts are data-processing shell scripts. The fastest feedback is piping sample input and checking output format.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `scripts/parse-test-output.sh` | Converts vitest JSON reporter output to structured case format |

### Modified Files

| File Path | Changes |
| --- | --- |
| `scripts/mark-tested.sh` | Use `parse-test-output.sh` for richer evidence; add `--json` flag to test command guidance; embed structured fields in `.case-tested` |
| `agents/implementer.md` | Update test piping command to use `--reporter=json` |

## Implementation Details

### parse-test-output.sh

**Pattern to follow**: `scripts/mark-tested.sh` (same style — bash, set -euo pipefail, reads stdin or file arg)

**Overview**: Reads vitest JSON reporter output from stdin or a file argument. Extracts key metrics and outputs structured YAML-like format (matching `.case-tested` conventions).

```bash
#!/usr/bin/env bash
set -euo pipefail

# Read vitest --reporter=json output from stdin or file
# Output: structured key-value pairs for .case-tested

if [[ $# -ge 1 && -f "$1" ]]; then
  INPUT="$1"
else
  INPUT=$(mktemp)
  cat > "$INPUT"
  trap "rm -f $INPUT" EXIT
fi

# Parse with node (available in all target repos — TS/pnpm stack)
node -e "
  const fs = require('fs');
  const data = JSON.parse(fs.readFileSync('$INPUT', 'utf8'));
  const results = {
    passed: data.numPassedTests || 0,
    failed: data.numFailedTests || 0,
    total: data.numTotalTests || 0,
    duration_ms: data.testResults
      ? data.testResults.reduce((s, r) => s + (r.perfStats?.end - r.perfStats?.start || 0), 0)
      : 0,
    suites: (data.testResults || []).length,
    files: (data.testResults || []).map(r => ({
      name: r.name?.split('/').slice(-1)[0] || 'unknown',
      status: r.status || 'unknown',
      tests: (r.assertionResults || []).length,
      duration_ms: (r.perfStats?.end - r.perfStats?.start) || 0
    }))
  };
  // Output as key-value pairs
  console.log('passed: ' + results.passed);
  console.log('failed: ' + results.failed);
  console.log('total: ' + results.total);
  console.log('duration_ms: ' + results.duration_ms);
  console.log('suites: ' + results.suites);
  // File breakdown as compact JSON array
  console.log('files: ' + JSON.stringify(results.files));
"
```

**Key decisions**:
- Use node for JSON parsing (available in all target repos, more reliable than jq for complex structures)
- Output as key-value pairs to match existing `.case-tested` format
- Include per-file breakdown so the reviewer agent can identify slow or failing test files

**Implementation steps**:
1. Create `scripts/parse-test-output.sh` with the node-based parser
2. Make executable: `chmod +x scripts/parse-test-output.sh`
3. Test with sample vitest JSON output
4. Verify output format matches expected key-value pairs

**Feedback loop**:
- **Playground**: Create a sample vitest JSON output file at `/tmp/test-vitest-output.json` with realistic structure
- **Experiment**: Pipe the sample through the parser, verify all fields are present. Test with 0 tests, 1 test, and many tests. Test with a failing test entry.
- **Check command**: `cat /tmp/test-vitest-output.json | bash scripts/parse-test-output.sh`

### Updated mark-tested.sh

**Pattern to follow**: Current `scripts/mark-tested.sh` (extend, don't rewrite)

**Overview**: Update to detect vitest JSON input (starts with `{`), route through `parse-test-output.sh` for structured evidence, and fall back to the current grep heuristic for non-JSON test output.

**Key decisions**:
- Backwards-compatible: if input is not JSON, fall back to current grep-based counting
- Hash still computed on raw output (same evidence chain)
- New fields appended to `.case-tested` alongside existing ones

**Implementation steps**:
1. After reading input to temp file, check if first non-whitespace char is `{`
2. If JSON: pipe through `parse-test-output.sh`, capture structured output
3. If not JSON: use existing grep-based heuristic
4. Append structured fields to `.case-tested` output
5. Keep hash computation on raw input (not parsed output)

**Feedback loop**:
- **Playground**: Use the same sample vitest JSON fixture from parse-test-output testing
- **Experiment**: Run `mark-tested.sh` with JSON input, verify `.case-tested` has both hash and structured fields. Run with plain text input, verify fallback works.
- **Check command**: `echo '{"numPassedTests":5,"numFailedTests":0,"numTotalTests":5,"testResults":[]}' | bash scripts/mark-tested.sh && cat .case-tested`

### Implementer update

Update the test piping command in `agents/implementer.md` to recommend JSON reporter when available:

```markdown
# In the Validate section, add guidance:
# Prefer JSON reporter for structured evidence:
pnpm test --reporter=json 2>&1 | bash /Users/nicknisi/Developer/case/scripts/mark-tested.sh
# Fallback if JSON reporter unavailable:
pnpm test 2>&1 | bash /Users/nicknisi/Developer/case/scripts/mark-tested.sh
```

## Testing Requirements

### Manual Testing

- [ ] `parse-test-output.sh` correctly parses vitest JSON with passing tests
- [ ] `parse-test-output.sh` correctly parses vitest JSON with failing tests
- [ ] `parse-test-output.sh` handles empty test results (0 tests)
- [ ] `mark-tested.sh` produces richer `.case-tested` when given JSON input
- [ ] `mark-tested.sh` falls back to grep heuristic for plain text input
- [ ] `.case-tested` still passes pre-PR hook validation (`output_hash:` present)

## Validation Commands

```bash
# Syntax check both scripts
bash -n scripts/parse-test-output.sh
bash -n scripts/mark-tested.sh

# Test with sample JSON
echo '{"numPassedTests":3,"numFailedTests":1,"numTotalTests":4,"testResults":[{"name":"test/foo.spec.ts","status":"failed","perfStats":{"start":0,"end":150},"assertionResults":[{"status":"passed"},{"status":"passed"},{"status":"passed"},{"status":"failed"}]}]}' | bash scripts/parse-test-output.sh

# Test mark-tested with JSON
echo '{"numPassedTests":3,"numFailedTests":0,"numTotalTests":3,"testResults":[]}' | bash scripts/mark-tested.sh
cat .case-tested
grep -q "output_hash:" .case-tested && echo "PASS: hash present" || echo "FAIL: hash missing"
grep -q "passed:" .case-tested && echo "PASS: structured data present" || echo "FAIL: structured data missing"

# Test mark-tested fallback with plain text
echo -e "Tests: 5 passed, 0 failed\n✓ test one\n✓ test two" | bash scripts/mark-tested.sh
cat .case-tested
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
