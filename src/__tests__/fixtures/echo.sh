#!/usr/bin/env bash
# Fixture used by commands.spec.ts to exercise spawnScript.
# Prints argv to stdout, optionally exits with $EXIT_CODE.
set -euo pipefail
echo "args: $*"
if [[ -n "${EXIT_CODE:-}" ]]; then
  exit "$EXIT_CODE"
fi
exit 0
