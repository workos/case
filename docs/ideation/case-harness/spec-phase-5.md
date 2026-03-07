# Implementation Spec: Case Harness - Phase 5: Enforcement Scripts

**Contract**: ./contract.md
**Estimated Effort**: S
**Blocked by**: Phase 3 (scripts enforce golden principles defined there)

## Technical Approach

Build the mechanical enforcement layer: scripts that verify repos comply with golden principles and conventions. These are the guardrails that prevent agent drift and ensure pattern consistency across repos.

Two scripts:
- `scripts/check.sh` — runs golden principle checks across all (or specified) repos. Outputs pass/fail per principle per repo. Error messages include remediation instructions (so agents reading the output know how to fix violations).
- `scripts/bootstrap.sh` — verifies a repo is ready for agent work (deps installed, tests pass, build works). Used at the start of any agent session.

Both scripts read `projects.json` for repo metadata. Both are designed to run from case/ and operate on sibling repos.

## Feedback Strategy

**Inner-loop command**: `bash scripts/check.sh --repo cli 2>&1 | tail -5`

**Playground**: Run scripts against actual repos and verify output is correct and actionable.

**Why this approach**: Scripts produce text output. The test is: does the output correctly identify violations, and do the remediation messages make sense?

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `scripts/check.sh` | Cross-repo golden principle enforcement |
| `scripts/bootstrap.sh` | Per-repo readiness verification |

## Implementation Details

### check.sh (Convention Enforcement)

**Overview**: Reads golden principles from `docs/golden-principles.md` and checks each repo against them. Designed to be run by humans or agents. Output includes remediation instructions.

**Key decisions**:
- Shell script (bash) — no dependencies beyond standard unix tools + node (for JSON parsing)
- Reads projects.json for repo list and commands
- Can target a specific repo (`--repo cli`) or all repos (default)
- Exit code 0 = all pass, 1 = failures found
- Each check prints: repo name, principle, PASS/FAIL, and remediation if FAIL

**Checks to implement (based on golden principles from Phase 3)**:
1. AGENTS.md exists
2. Required commands work (test, lint, typecheck, build) — dry-run check (command exists in package.json)
3. Conventional commits on recent commits (check last 10 commits)
4. No files over max line count threshold
5. package.json has required fields (name, version, description, license)
6. Tests pass (optional, gated behind `--run-tests` flag since it's slow)

**Output format**:
```
=== cli (../cli/main) ===
  [PASS] AGENTS.md exists
  [PASS] Required commands: test, lint, typecheck, build
  [FAIL] File size limit: src/commands/installer.ts (847 lines > 500 max)
         FIX: Split into smaller modules. See docs/conventions/code-style.md
  [PASS] Conventional commits (last 10)
  [PASS] package.json fields

=== authkit-nextjs (../authkit-nextjs) ===
  ...

Summary: 23/25 checks passed across 5 repos
```

**Implementation steps**:
1. Parse projects.json to get repo list, paths, and commands
2. Implement each check as a function that returns pass/fail + remediation message
3. Add `--repo` flag for single-repo mode
4. Add `--run-tests` flag for optional test execution
5. Add summary output with total pass/fail count
6. Test against all 5 v1 repos

**Feedback loop**:
- **Playground**: Run against repos and verify output accuracy
- **Experiment**: Intentionally introduce a violation (e.g., create a 600-line file) and verify it's caught
- **Check command**: `bash scripts/check.sh --repo cli`

### bootstrap.sh (Repo Readiness)

**Overview**: Verifies a single repo is ready for agent work. Meant to be run at the start of an agent session — ensures deps are installed, tests pass, and build works.

**Key decisions**:
- Takes repo name as argument, looks up path and commands from projects.json
- Runs: setup command (install deps), then test, then build
- Stops on first failure with clear error message
- Outputs timing for each step
- Exit code 0 = ready, 1 = not ready

**Output format**:
```
Bootstrapping cli (../cli/main)...
  [OK] pnpm install (3.2s)
  [OK] pnpm test (12.4s)
  [OK] pnpm build (5.1s)
Ready. Total: 20.7s
```

**Implementation steps**:
1. Parse repo name from args, look up in projects.json
2. cd to repo path
3. Run setup command, capture output, report pass/fail + timing
4. Run test command (same)
5. Run build command (same)
6. Report overall status

**Feedback loop**:
- **Playground**: Run against a real repo
- **Experiment**: Run against each of the 5 v1 repos
- **Check command**: `bash scripts/bootstrap.sh cli`

## Testing Requirements

- [ ] check.sh runs successfully against all 5 v1 repos
- [ ] check.sh correctly identifies at least one real violation (if any exist)
- [ ] check.sh `--repo` flag works for single-repo mode
- [ ] check.sh remediation messages reference real docs
- [ ] bootstrap.sh runs successfully on at least 3 of 5 repos
- [ ] bootstrap.sh fails gracefully when deps aren't installed
- [ ] Both scripts exit with correct codes (0 = success, 1 = failure)

## Validation Commands

```bash
# Run check against all repos
bash scripts/check.sh

# Run check against single repo
bash scripts/check.sh --repo cli

# Run bootstrap on each repo
for repo in cli skills authkit-session authkit-tanstack-start authkit-nextjs; do
  echo "=== Bootstrapping $repo ==="
  bash scripts/bootstrap.sh "$repo"
  echo ""
done

# Verify scripts are executable
[ -x scripts/check.sh ] && echo "check.sh executable" || echo "check.sh NOT executable"
[ -x scripts/bootstrap.sh ] && echo "bootstrap.sh executable" || echo "bootstrap.sh NOT executable"
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
