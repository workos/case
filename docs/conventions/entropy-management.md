# Entropy Management

Convention drift happens. Agent-generated code replicates existing patterns,
including suboptimal ones. Continuous scanning catches drift early.

## Quick Scan

Run a one-time scan across all repos:

```bash
bash scripts/entropy-scan.sh
```

Scan a specific repo:

```bash
bash scripts/entropy-scan.sh --repo cli
```

## Continuous Scanning with /loop

During active work sessions, scan periodically:

```
/loop 30m bash scripts/entropy-scan.sh
```

This runs every 30 minutes while your session is active. The scan:

- Always exits 0 (won't break the loop)
- Reports status as JSON (`clean` or `drift_detected`)
- Lists specific failures for you to address

### Recommended intervals

| Scenario                 | Interval | Command                                               |
| ------------------------ | -------- | ----------------------------------------------------- |
| Active multi-repo work   | 30m      | `/loop 30m bash scripts/entropy-scan.sh`              |
| Focused single-repo work | 1h       | `/loop 1h bash scripts/entropy-scan.sh --repo {name}` |
| Background monitoring    | 2h       | `/loop 2h bash scripts/entropy-scan.sh`               |

### Limitations

- `/loop` is session-scoped — tasks stop when you close the terminal
- 3-day maximum expiry on recurring tasks
- No catch-up if Claude is busy when a scan is due
- For persistent scanning, consider GitHub Actions (future improvement)

## What Gets Checked

`entropy-scan.sh` wraps `check.sh`, which validates:

1. CLAUDE.md exists in each repo
2. Required commands in package.json
3. Conventional commits (last 10)
4. Source file sizes (< 500 lines)
5. package.json required fields

See `docs/golden-principles.md` for the full list of invariants.

## Acting on Drift

When drift is detected:

1. Read the failures array in the JSON output
2. Fix the lowest-effort issues first (commit format, missing fields)
3. For structural issues (file sizes, missing tests), create a task in `tasks/active/`
4. Run `check.sh --repo {name}` to verify fixes
