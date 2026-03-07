# Implementation Spec: Case Harness - Phase 4: Playbooks + Task System

**Contract**: ./contract.md
**Estimated Effort**: M
**Blocked by**: Phase 3 (playbooks reference architecture docs and conventions)

## Technical Approach

Build the playbooks (step-by-step agent-executable plans for recurring operations) and task templates (pre-filled task files that encode the decisions a playbook requires). Together, these are what make "queue work, review PRs" possible — the human fills in a template, drops it in tasks/active/, and an agent executes it.

Playbooks live in `docs/playbooks/` and are reference documentation. Task templates live in `tasks/templates/` and are fill-in-the-blank files agents execute against. A playbook explains the *why* and *how*. A task template is the *what* — scoped to a specific instance.

The playbook set for v1:
1. **Add CLI command** — add a new resource command to the CLI
2. **Add AuthKit framework** — create a new AuthKit integration for a framework
3. **Fix a bug** — triage and fix a bug in any target repo
4. **Cross-repo update** — make a coordinated change across multiple repos

Each playbook gets a corresponding task template.

## Feedback Strategy

**Inner-loop command**: `ls tasks/templates/*.md | wc -l` (track template count)

**Playground**: None — documentation work. Quality validated by using a template to dispatch a real task after implementation.

**Why this approach**: The real test is: can an agent given a filled-in task template produce a good PR? That's an integration test done manually after this phase.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `docs/playbooks/add-cli-command.md` | Step-by-step guide for adding a CLI command |
| `docs/playbooks/add-authkit-framework.md` | Step-by-step guide for new AuthKit framework integration |
| `docs/playbooks/fix-bug.md` | Step-by-step guide for triaging and fixing a bug |
| `docs/playbooks/cross-repo-update.md` | Step-by-step guide for coordinated cross-repo changes |
| `docs/playbooks/README.md` | Index of playbooks |
| `tasks/templates/cli-command.md` | Task template for adding a CLI command |
| `tasks/templates/authkit-framework.md` | Task template for new AuthKit framework |
| `tasks/templates/bug-fix.md` | Task template for bug fixes |
| `tasks/templates/cross-repo-update.md` | Task template for cross-repo changes |

## Implementation Details

### Playbook: Add CLI Command (`docs/playbooks/add-cli-command.md`)

**Pattern to follow**: `../cli/main/CLAUDE.md` (existing "Adding a New Resource Command" section)

**Overview**: Detailed guide for adding a new resource command to the WorkOS CLI. References docs/architecture/cli.md for the architectural context.

**Key content**:
- Prerequisites: what to know before starting (API endpoint exists, resource schema)
- Step 1: Create src/commands/{resource}.ts following patterns in organization.ts
- Step 2: Create src/commands/{resource}.spec.ts with JSON mode tests
- Step 3: Register in src/bin.ts
- Step 4: Update src/utils/help-json.ts command registry
- Step 5: Run tests, typecheck, lint
- Step 6: Open PR following conventions
- Verification checklist

**Implementation steps**:
1. Read docs/architecture/cli.md (from Phase 3) for context
2. Read existing CLI commands (organization.ts, user.ts) as examples
3. Write step-by-step playbook with concrete file paths and code patterns
4. Include "common mistakes" section based on patterns that break

### Playbook: Add AuthKit Framework (`docs/playbooks/add-authkit-framework.md`)

**Pattern to follow**: `docs/architecture/authkit-framework.md` (from Phase 3)

**Overview**: Guide for creating a new AuthKit integration for a framework (e.g., Remix, Nuxt, SolidStart).

**Key content**:
- Prerequisites: framework familiarity, authkit-session understanding
- Step 1: Scaffold repo structure (mirror authkit-nextjs layout)
- Step 2: Implement session adapter using authkit-session
- Step 3: Implement middleware/route handler for the framework
- Step 4: Implement provider component and hooks
- Step 5: Add tests
- Step 6: Add AGENTS.md following per-repo standard
- Step 7: Configure CI, release-please, package.json
- Verification: test auth flow end-to-end

### Playbook: Fix a Bug (`docs/playbooks/fix-bug.md`)

**Overview**: Generic playbook for triaging and fixing a bug in any target repo.

**Key content**:
- Step 1: Read the issue/report — understand the expected vs actual behavior
- Step 2: Identify the target repo from the issue context
- Step 3: Read the repo's AGENTS.md for setup and architecture
- Step 4: Reproduce the bug (write a failing test first if possible)
- Step 5: Identify root cause
- Step 6: Implement fix
- Step 7: Verify fix (test passes, no regressions)
- Step 8: Open PR with issue reference
- Common patterns: check if the bug exists in related repos (e.g., same session bug across AuthKit packages)

### Playbook: Cross-Repo Update (`docs/playbooks/cross-repo-update.md`)

**Overview**: Guide for making a coordinated change across multiple repos (e.g., update README badges, add new shared convention, update dependency versions).

**Key content**:
- Step 1: Define the change and affected repos (reference projects.json)
- Step 2: Create per-repo task files (or one x-prefixed cross-repo task)
- Step 3: For each repo — read AGENTS.md, make change, run checks, open PR
- Step 4: Cross-validate consistency across all PRs
- Step 5: Merge in dependency order if applicable
- When to use single cross-repo task vs multiple per-repo tasks

### Task Templates

Each template follows the format defined in tasks/README.md (Phase 1). Templates include placeholder fields wrapped in `{curly braces}` that the human fills in.

**CLI Command template** (`tasks/templates/cli-command.md`):
```markdown
# Add CLI Command: {command-name}

## Objective
Add `workos {command-name}` command to the CLI.

## Target Repos
- ../cli/main

## Playbook
docs/playbooks/add-cli-command.md

## Context
{Describe what this command does, what API endpoint it calls, expected input/output}

## Acceptance Criteria
- [ ] Command registered and appears in help
- [ ] Subcommands: {list, get, create, update, delete — specify which}
- [ ] JSON output mode works
- [ ] Tests pass
- [ ] Types check

## Checklist
- [ ] Read playbook and architecture doc
- [ ] Create command file
- [ ] Create spec file
- [ ] Register in bin.ts
- [ ] Update help-json.ts
- [ ] Run all checks
- [ ] Open PR
```

**Bug fix template** (`tasks/templates/bug-fix.md`):
```markdown
# Fix: {brief description}

## Objective
{What's broken and what the fix should achieve}

## Target Repos
- {../repo-path}

## Playbook
docs/playbooks/fix-bug.md

## Issue Reference
{GitHub issue URL or description}

## Acceptance Criteria
- [ ] Bug is reproducible with a test
- [ ] Fix addresses root cause
- [ ] No regressions (all existing tests pass)
- [ ] New test prevents recurrence

## Checklist
- [ ] Read repo AGENTS.md
- [ ] Reproduce bug
- [ ] Write failing test
- [ ] Implement fix
- [ ] Verify all checks pass
- [ ] Open PR referencing issue
```

**Cross-repo update template** and **AuthKit framework template** follow the same pattern — objective, target repos, playbook reference, context, acceptance criteria, checklist.

## Testing Requirements

- [ ] Each playbook references docs that exist (architecture docs from Phase 3)
- [ ] Each playbook's steps are concrete and actionable (not vague)
- [ ] Each task template has all required sections from tasks/README.md (Phase 1)
- [ ] Template placeholder fields are wrapped in `{curly braces}`
- [ ] At least one template is filled in and tested with a real agent dispatch

## Validation Commands

```bash
# Verify all playbooks and templates exist
for f in \
  docs/playbooks/add-cli-command.md \
  docs/playbooks/add-authkit-framework.md \
  docs/playbooks/fix-bug.md \
  docs/playbooks/cross-repo-update.md \
  docs/playbooks/README.md \
  tasks/templates/cli-command.md \
  tasks/templates/authkit-framework.md \
  tasks/templates/bug-fix.md \
  tasks/templates/cross-repo-update.md; do
  [ -f "$f" ] && echo "OK: $f" || echo "MISSING: $f"
done

# Verify playbooks reference existing architecture docs
grep -roh 'docs/[^ )]*\.md' docs/playbooks/ | sort -u | while read ref; do
  [ -f "$ref" ] && echo "OK: $ref" || echo "BROKEN REF: $ref"
done

# Verify templates have required sections
for tmpl in tasks/templates/*.md; do
  echo "=== $tmpl ==="
  for section in "## Objective" "## Target Repos" "## Playbook" "## Acceptance Criteria" "## Checklist"; do
    grep -q "$section" "$tmpl" && echo "  OK: $section" || echo "  MISSING: $section"
  done
done
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
