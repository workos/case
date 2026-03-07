# Implementation Spec: Case Harness - Phase 2: Per-Repo AGENTS.md

**Contract**: ./contract.md
**Estimated Effort**: L
**Blocked by**: Phase 1 (needs projects.json for repo metadata)

## Technical Approach

Create or upgrade AGENTS.md files in each of the 5 v1 target repos. Each AGENTS.md must be self-sufficient — an agent landing in that repo alone (without case/) should be able to do competent work. The files follow a standard structure but contain repo-specific content derived from deep reading of each codebase.

Some repos already have CLAUDE.md files with useful content. The approach is:
- If CLAUDE.md exists with good content → create AGENTS.md alongside it, migrating relevant content and adding missing sections. Keep CLAUDE.md for Claude Code-specific instructions if needed.
- If no CLAUDE.md exists → create AGENTS.md from scratch.

The standard AGENTS.md structure for all repos:

```markdown
# {Repo Name}

{1-2 line description}

## Commands

{Exact commands for: setup, test, lint, typecheck, build}

## Project Structure

{Key directories and files with brief descriptions}

## Architecture

{How the codebase is organized, key patterns, dependency flow}

## Do / Don't

### Do
- {Pattern to follow with file reference}

### Don't
- {Anti-pattern to avoid with explanation}

## PR Checklist

- [ ] Tests pass
- [ ] Types check
- [ ] Lint clean
- [ ] {Repo-specific checks}
```

Each repo requires the agent to: read the codebase thoroughly, understand its patterns, identify what makes a good PR in that repo, and document it concisely.

## Feedback Strategy

**Inner-loop command**: `wc -l AGENTS.md && head -5 AGENTS.md` (per repo)

**Playground**: None — this is documentation work. Validation is reading the result and checking completeness.

**Why this approach**: Output is markdown. The only structural check is that all required sections exist and commands are accurate (verified by running them).

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `../cli/main/AGENTS.md` | Agent instructions for the WorkOS CLI repo |
| `../skills/AGENTS.md` | Agent instructions for the skills plugin repo (has existing CLAUDE.md) |
| `../authkit-session/AGENTS.md` | Agent instructions for authkit-session (has existing CLAUDE.local.md) |
| `../authkit-tanstack-start/AGENTS.md` | Agent instructions for authkit-tanstack-start |
| `../authkit-nextjs/AGENTS.md` | Agent instructions for authkit-nextjs (has existing CLAUDE.md) |

## Implementation Details

### Per-Repo Exploration Process

For each repo, the implementing agent must:

1. Read existing CLAUDE.md / CLAUDE.local.md if present
2. Read package.json for commands, dependencies, project description
3. Read src/ directory structure to understand architecture
4. Read 2-3 representative source files to identify patterns
5. Read test files to understand testing approach
6. Read any existing docs/ directory
7. Run the test and build commands to verify they work
8. Synthesize into AGENTS.md following the standard structure

### CLI (`../cli/main`)

**Existing context**: Has CLAUDE.md with good content — architecture (adapter pattern, event emitter), commands, conventions, and guides for adding new commands/resources.

**Key patterns to document**:
- Three adapters (CLI, Dashboard, Headless) subscribing to InstallerEventEmitter
- OutputMode (human/json) resolved at startup
- Non-TTY behavior and exit codes
- Conventional commits with release-please
- How to add a new framework installer
- How to add a new resource command

**Approach**: AGENTS.md can build on existing CLAUDE.md content. Add: project structure map, do/don't with file references, PR checklist.

### Skills (`../skills`)

**Existing context**: Has CLAUDE.md with eval commands, project structure, key conventions.

**Key patterns to document**:
- Plugin structure (.claude-plugin/)
- Hand-crafted AuthKit skills vs topic files
- Router (workos/SKILL.md) handles discovery
- "Fetch docs first" core pattern
- Eval framework for testing skills
- Gotchas encode what the LLM gets wrong

**Approach**: AGENTS.md adds: architecture overview, do/don't, PR checklist. Existing CLAUDE.md content is strong — mostly needs restructuring into standard sections.

### AuthKit Session (`../authkit-session`)

**Existing context**: Has CLAUDE.local.md with detailed overview, setup, testing, architecture.

**Key patterns to document**:
- Framework-agnostic design with pluggable storage adapters
- WebCrypto API for encryption (Node >= 20)
- Session lifecycle (create, refresh, revoke)
- How it relates to framework-specific AuthKit packages (replaces their session management)
- Test coverage threshold: 80%

**Approach**: CLAUDE.local.md has extensive content. AGENTS.md distills the actionable parts: commands, structure, patterns, do/don't.

### AuthKit TanStack Start (`../authkit-tanstack-start`)

**Existing context**: Need to explore — may or may not have CLAUDE.md.

**Key patterns to document**:
- TanStack Start-specific patterns (server functions, createServerFn)
- How it consumes authkit-session
- Middleware integration pattern
- Provider/hook pattern for client-side

**Approach**: Explore codebase, identify patterns, create AGENTS.md from scratch or existing docs.

### AuthKit Next.js (`../authkit-nextjs`)

**Existing context**: Has CLAUDE.md with architecture overview, commands, testing patterns.

**Key patterns to document**:
- Middleware-based authentication (src/middleware.ts)
- Encrypted sessions with iron-session
- Provider pattern (AuthKitProvider)
- Hook architecture (useAuth, useAccessToken, useTokenClaims)
- How it consumes authkit-session (or will in the future)

**Approach**: Existing CLAUDE.md has good architecture content. AGENTS.md adds: project structure map, do/don't with file references, PR checklist.

## Testing Requirements

Per repo, verify:
- [ ] All commands listed in AGENTS.md actually work when run
- [ ] Project structure section matches actual directory layout
- [ ] Architecture section accurately describes the codebase
- [ ] Do/don't patterns reference real files that exist

## Validation Commands

```bash
# For each repo, verify commands work:
cd ../cli/main && pnpm test && pnpm typecheck && pnpm build
cd ../skills && pnpm test && pnpm lint
cd ../authkit-session && pnpm test && pnpm build
cd ../authkit-tanstack-start && pnpm test && pnpm build
cd ../authkit-nextjs && pnpm test && pnpm build

# Verify AGENTS.md exists in all repos:
for repo in ../cli/main ../skills ../authkit-session ../authkit-tanstack-start ../authkit-nextjs; do
  [ -f "$repo/AGENTS.md" ] && echo "OK: $repo" || echo "MISSING: $repo"
done

# Check all AGENTS.md files have required sections:
for repo in ../cli/main ../skills ../authkit-session ../authkit-tanstack-start ../authkit-nextjs; do
  echo "=== $repo ==="
  for section in "## Commands" "## Project Structure" "## Architecture" "## Do" "## Don't" "## PR Checklist"; do
    grep -q "$section" "$repo/AGENTS.md" && echo "  OK: $section" || echo "  MISSING: $section"
  done
done
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
