# Case Harness

Case is a spine/meta-repo for orchestrating agent work across WorkOS open source projects.
It provides the cross-cutting knowledge, conventions, and task dispatch that no single repo owns.

## Philosophy

- **Humans steer, agents execute.** Nick defines goals and acceptance criteria. Agents implement.
- **Never write code directly.** All code changes in target repos flow through agents. Nick only improves this harness.
- **When agents struggle, fix the harness.** The fix is never "try harder" — it's a missing doc, playbook, convention, or enforcement rule.
- **Give a map, not a manual.** AGENTS.md is ~100 lines. Deeper docs live in docs/. Progressive disclosure.

## What Belongs Here vs In Individual Repos

**In case/:**
- Cross-repo conventions and golden principles
- Architecture patterns that span multiple repos
- Playbooks for recurring operations
- Task files and templates
- Enforcement scripts (check.sh, bootstrap.sh)
- The /case Claude Code plugin skill

**In individual repos:**
- AGENTS.md with repo-specific instructions
- Repo-specific CI, linters, test config
- Code and tests

## Relationship to Skills Plugin

- `skills` (`../skills`) = WorkOS **domain knowledge** (what is SSO, how AuthKit works, API endpoints, gotchas)
- `case` = **orchestration layer** (which repos exist, how to work across them, patterns, playbooks, task dispatch)

Case depends on the skills plugin for product knowledge. They are complementary, not overlapping.

## Project Structure

```
AGENTS.md                 # Entry point for agents (routing map)
CLAUDE.md                 # This file (meta-instructions for case itself)
projects.json             # Manifest of target repos
projects.schema.json      # JSON Schema for the manifest
docs/
  architecture/           # Canonical patterns per repo type
  conventions/            # Shared rules (commits, testing, PRs)
  golden-principles.md    # Invariants enforced across all repos
  playbooks/              # Step-by-step guides for recurring operations
tasks/
  active/                 # Current task files for agent execution
  done/                   # Completed tasks (moved after PR merge)
  templates/              # Reusable task templates
scripts/
  check.sh               # Cross-repo convention enforcement
  bootstrap.sh            # Per-repo readiness verification
```

## Commands

```bash
# Validate manifest
node -e "JSON.parse(require('fs').readFileSync('projects.json','utf8'))"

# Check conventions across repos
bash scripts/check.sh

# Check a single repo
bash scripts/check.sh --repo cli

# Bootstrap a repo for agent work
bash scripts/bootstrap.sh cli
```
