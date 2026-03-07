# Implementation Spec: Case Harness - Phase 3: Knowledge Base

**Contract**: ./contract.md
**Estimated Effort**: L
**Blocked by**: Phase 1 (needs directory structure and manifest)

## Technical Approach

Build the knowledge base that sits at the heart of the harness: architecture docs, conventions, and golden principles. These are the documents that make agents effective across repos — they capture the cross-cutting knowledge no single repo contains.

The approach is empirical, not theoretical: read the actual repos, extract the patterns that exist, document the canonical versions, and note deviations. Architecture docs describe how things *should* work (based on the best examples). Conventions docs describe shared rules. Golden principles are the invariants that must hold across all repos.

Every doc should be concise and agent-oriented — scannable, actionable, with concrete file references. Progressive disclosure: agents start with AGENTS.md, drill into these docs only when needed.

## Feedback Strategy

**Inner-loop command**: `find docs/ -name "*.md" | xargs wc -l | tail -1` (track total docs size)

**Playground**: None — documentation work. Validation is structural completeness and accuracy against actual repo code.

**Why this approach**: Output is markdown. Quality is measured by whether agents given these docs produce correct work in target repos.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `docs/architecture/cli.md` | Canonical patterns for the WorkOS CLI |
| `docs/architecture/authkit-framework.md` | Canonical pattern for AuthKit framework integrations |
| `docs/architecture/authkit-session.md` | Canonical pattern for session management |
| `docs/architecture/skills-plugin.md` | Canonical pattern for the skills plugin |
| `docs/architecture/README.md` | Index of architecture docs |
| `docs/conventions/commits.md` | Commit message conventions (shared) |
| `docs/conventions/testing.md` | Testing standards per repo type |
| `docs/conventions/pull-requests.md` | PR structure and review expectations |
| `docs/conventions/code-style.md` | Shared code style rules (file size, naming, etc.) |
| `docs/conventions/README.md` | Index of convention docs |
| `docs/golden-principles.md` | Invariants enforced across all repos |

## Implementation Details

### Architecture: CLI (`docs/architecture/cli.md`)

**Pattern to follow**: `../cli/main/CLAUDE.md` (existing architecture section)

**Overview**: Documents the canonical structure of the CLI — adapter pattern, event emitter, command registration, output modes. This is what an agent reads before adding a new command or framework installer.

**Key content**:
- Adapter pattern (CLI, Dashboard, Headless) → InstallerEventEmitter
- Command structure: src/commands/{resource}.ts + spec
- Framework installer structure: src/{framework}/{framework}-installer-agent.ts
- OutputMode (human/json) and Non-TTY behavior
- Registration in bin.ts, help-json.ts

**Implementation steps**:
1. Read ../cli/main deeply — src/ structure, key files, patterns
2. Document the adapter/event-emitter architecture with a dependency diagram
3. Document the "add a command" pattern step by step
4. Document the "add a framework installer" pattern step by step
5. Include concrete file paths as references

### Architecture: AuthKit Framework (`docs/architecture/authkit-framework.md`)

**Pattern to follow**: `../authkit-nextjs/` as reference implementation

**Overview**: Documents the canonical pattern for building an AuthKit integration for any framework. An agent creating a new AuthKit framework integration should be able to follow this doc.

**Key content**:
- Common structure: middleware → session management → provider → hooks
- How framework integrations consume authkit-session
- Required exports: middleware config, auth helpers, provider component, hooks
- Framework-specific adapter points (what changes per framework vs what's shared)
- Comparison: Next.js vs TanStack Start approaches

**Implementation steps**:
1. Read authkit-nextjs and authkit-tanstack-start in parallel
2. Identify the shared pattern and framework-specific deviations
3. Document the canonical pattern as a template
4. Note where authkit-session provides the shared layer
5. Include file path references from both repos

### Architecture: AuthKit Session (`docs/architecture/authkit-session.md`)

**Pattern to follow**: `../authkit-session/CLAUDE.local.md`

**Overview**: Documents the session management layer that framework integrations build on.

**Key content**:
- Framework-agnostic design with pluggable storage adapters
- Session lifecycle: create, refresh, revoke
- Encryption approach (WebCrypto/iron-session)
- How framework packages integrate with authkit-session
- Storage adapter interface

**Implementation steps**:
1. Read authkit-session src/ thoroughly
2. Document the adapter interface and lifecycle
3. Document how framework packages consume it
4. Include concrete type signatures and file references

### Architecture: Skills Plugin (`docs/architecture/skills-plugin.md`)

**Pattern to follow**: `../skills/CLAUDE.md`

**Overview**: Documents how the skills plugin is structured — useful for agents maintaining or extending skills.

**Key content**:
- Plugin structure: .claude-plugin/, marketplace.json, plugin.json
- Skill types: hand-crafted AuthKit skills vs topic files vs router
- "Fetch docs first" pattern
- Eval framework for testing skill quality
- How to add a new topic file vs a new skill

**Implementation steps**:
1. Read skills repo structure
2. Document plugin manifest structure
3. Document skill authoring patterns
4. Document eval framework usage
5. Include file path references

### Conventions: Commits (`docs/conventions/commits.md`)

**Overview**: Shared commit conventions across all repos.

**Key content**:
- Conventional Commits format (all repos use this)
- release-please integration
- Breaking change suffix (`feat!:`)
- Scope conventions per repo

**Implementation steps**:
1. Check each repo's commit history to verify conventional commits usage
2. Document the shared standard
3. Note any per-repo variations

### Conventions: Testing (`docs/conventions/testing.md`)

**Overview**: Testing standards — what's expected per repo type.

**Key content**:
- All repos: tests must pass before PR
- Coverage expectations (authkit-session: 80% threshold, others vary)
- Test framework: vitest (authkit-session, skills), jest (authkit-nextjs)
- Test file naming: *.spec.ts / *.test.ts conventions
- What to test: public API surface, edge cases, error paths

**Implementation steps**:
1. Survey test setup across all 5 repos (test framework, config, coverage)
2. Document the shared expectations
3. Note per-repo deviations

### Conventions: Pull Requests (`docs/conventions/pull-requests.md`)

**Overview**: What a good PR looks like across WorkOS OSS repos.

**Key content**:
- Small, focused PRs (one concern per PR)
- PR description template
- Required checks before merge (tests, types, lint, build)
- Changelog considerations (conventional commits drive release-please)

### Conventions: Code Style (`docs/conventions/code-style.md`)

**Overview**: Shared code style rules.

**Key content**:
- TypeScript strict mode (all repos)
- Formatter: prettier (authkit-nextjs), oxfmt (skills), prettier (authkit-session)
- Linter: eslint vs oxlint
- File size guidance (avoid god-files)
- Naming conventions

**Implementation steps**:
1. Survey formatter/linter config across all 5 repos
2. Document shared rules vs per-repo tools
3. Note inconsistencies that should converge

### Golden Principles (`docs/golden-principles.md`)

**Overview**: The invariants that must hold across all repos. These are what `scripts/check.sh` (Phase 5) enforces.

**Key content**:
- Every repo must have: AGENTS.md, working test/lint/typecheck/build commands
- Tests must pass on the default branch at all times
- Conventional commits for all changes
- No files over N lines (TBD based on codebase survey)
- Public API changes require test coverage
- Dependencies must be explicitly declared (no implicit peer deps)
- Boundary validation for external data (API responses, user input)

**Implementation steps**:
1. Survey all 5 repos for existing patterns and pain points
2. Draft principles based on what's already true (document reality, then aspirations)
3. Mark each principle as "enforced" (scripts/check.sh can verify) or "advisory" (human judgment)
4. Keep the list short — 10-15 principles max

## Testing Requirements

- [ ] Every architecture doc references real file paths that exist in the target repos
- [ ] Every command listed in conventions docs actually works when run
- [ ] Golden principles are categorized as enforced vs advisory
- [ ] No doc exceeds 200 lines (conciseness constraint)

## Validation Commands

```bash
# Check all docs exist
for f in \
  docs/architecture/cli.md \
  docs/architecture/authkit-framework.md \
  docs/architecture/authkit-session.md \
  docs/architecture/skills-plugin.md \
  docs/architecture/README.md \
  docs/conventions/commits.md \
  docs/conventions/testing.md \
  docs/conventions/pull-requests.md \
  docs/conventions/code-style.md \
  docs/conventions/README.md \
  docs/golden-principles.md; do
  [ -f "$f" ] && echo "OK: $f" || echo "MISSING: $f"
done

# Check no doc exceeds 200 lines
find docs/ -name "*.md" -exec sh -c 'lines=$(wc -l < "$1"); [ "$lines" -gt 200 ] && echo "TOO LONG ($lines): $1"' _ {} \;

# Verify file references in architecture docs point to real files
grep -roh '\.\./[^ )]*\.[a-z]*' docs/architecture/ | sort -u | while read ref; do
  [ -e "$ref" ] && echo "OK: $ref" || echo "BROKEN REF: $ref"
done
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
