#!/usr/bin/env bash
# Parse vitest JSON reporter output into structured key-value format.
# Agents pipe vitest --reporter=json output through this to get machine-readable
# evidence for .case-tested markers.
#
# Usage: bash /path/to/parse-test-output.sh <json-file>
# Or pipe: vitest --reporter=json 2>&1 | bash /path/to/parse-test-output.sh
#
# Output: key-value pairs (one per line) suitable for embedding in .case-tested

set -euo pipefail

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
