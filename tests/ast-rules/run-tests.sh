#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RULES_DIR="$SCRIPT_DIR/../../ast-rules"
FIXTURES_DIR="$SCRIPT_DIR/fixtures"

echo "=== Testing target rule violation detection ==="
target_count=0
for rule in "$RULES_DIR"/target/*.yml; do
  rule_name=$(basename "$rule" .yml)
  matches=$(npx ast-grep scan --rule "$rule" "$FIXTURES_DIR/violations/" --json 2>/dev/null || true)
  count=$(echo "$matches" | jq 'length' 2>/dev/null || echo "0")
  if [ "$count" -eq 0 ]; then
    echo "FAIL: Rule $rule_name produced no violations"
    exit 1
  fi
  echo "  $rule_name: $count violation(s)"
  target_count=$((target_count + count))
done
echo "PASS: Detected $target_count target rule violations"

echo "=== Testing self-enforcement rule violation detection ==="
self_count=0
for rule in "$RULES_DIR"/self/*.yml; do
  rule_name=$(basename "$rule" .yml)
  matches=$(npx ast-grep scan --rule "$rule" "$FIXTURES_DIR/violations/" --json 2>/dev/null || true)
  count=$(echo "$matches" | jq 'length' 2>/dev/null || echo "0")
  if [ "$count" -eq 0 ]; then
    echo "FAIL: Rule $rule_name produced no violations"
    exit 1
  fi
  echo "  $rule_name: $count violation(s)"
  self_count=$((self_count + count))
done
echo "PASS: Detected $self_count self-enforcement violations"

echo "=== Testing clean fixtures ==="
clean_count=0
for rule in "$RULES_DIR"/target/*.yml "$RULES_DIR"/self/*.yml; do
  matches=$(npx ast-grep scan --rule "$rule" "$FIXTURES_DIR/clean/" --json 2>/dev/null || true)
  count=$(echo "$matches" | jq 'length' 2>/dev/null || echo "0")
  clean_count=$((clean_count + count))
done
if [ "$clean_count" -ne 0 ]; then
  echo "FAIL: Found $clean_count false positives in clean fixtures"
  for rule in "$RULES_DIR"/target/*.yml "$RULES_DIR"/self/*.yml; do
    npx ast-grep scan --rule "$rule" "$FIXTURES_DIR/clean/" 2>/dev/null || true
  done
  exit 1
fi
echo "PASS: No false positives"

echo "=== Supplementary shell checks ==="

echo "--- max-file-length (advisory) ---"
long_files=0
while IFS= read -r f; do
  lines=$(wc -l < "$f")
  if [ "$lines" -gt 300 ]; then
    echo "warning: $f exceeds 300 lines ($lines lines)"
    long_files=$((long_files + 1))
  fi
done < <(find "$SCRIPT_DIR/../.." -name '*.ts' -not -path '*/node_modules/*' -not -path '*/.claude/*' -not -name '*.test.ts' -not -name '*.spec.ts' -not -path '*/fixtures/*')
if [ "$long_files" -gt 0 ]; then
  echo "INFO: $long_files file(s) exceed 300 lines (advisory, non-blocking)"
else
  echo "PASS: No files exceed 300 lines"
fi

echo "--- strict-mode (tsconfig check) ---"
TSCONFIG="$SCRIPT_DIR/../../tsconfig.json"
if [ -f "$TSCONFIG" ]; then
  if ! grep -q '"strict": true' "$TSCONFIG" 2>/dev/null; then
    echo "FAIL: tsconfig.json missing \"strict\": true"
    exit 1
  fi
  echo "PASS: tsconfig.json has strict mode enabled"
else
  echo "SKIP: No tsconfig.json found"
fi

echo ""
echo "All ast-grep rule tests passed."
