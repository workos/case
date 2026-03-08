# Cross-Repo: {brief description}

## Objective

{What needs to change and why it must be coordinated across repos.}

## Target Repos

{List all affected repos. Check projects.json to ensure none are missed.}

- ../cli/main
- ../skills
- ../authkit-session
- ../authkit-tanstack-start
- ../authkit-nextjs

## Playbook

docs/playbooks/cross-repo-update.md

## Context

{Why this change is needed. Link to discussion, issue, or upstream change that drives it.}

Dependency order (if applicable): {e.g., authkit-session first, then framework packages, then cli}

## Acceptance Criteria

- [ ] Change applied consistently across all affected repos
- [ ] No repo missed (verified against `projects.json`)
- [ ] All repo checks pass independently
- [ ] PRs cross-reference each other
- [ ] Merged in correct dependency order (if applicable)

## Per-Repo Changes

### {repo-1}

- {Describe specific changes for this repo}
- Checks: {pnpm test && pnpm typecheck && ...}

### {repo-2}

- {Describe specific changes for this repo}
- Checks: {pnpm test && pnpm typecheck && ...}

{Repeat for each affected repo.}

## Checklist

- [ ] Read playbook (`docs/playbooks/cross-repo-update.md`)
- [ ] Verify affected repos from `projects.json`
- [ ] Read AGENTS.md for each affected repo
- [ ] Apply change to {repo-1}, run checks, open PR
- [ ] Apply change to {repo-2}, run checks, open PR
- [ ] {Repeat for each repo}
- [ ] Cross-validate consistency across all PRs
- [ ] Merge in dependency order (if applicable)

## Progress Log

<!-- Agents append entries below. Do not edit existing entries. -->
