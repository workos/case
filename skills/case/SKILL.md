---
name: case
description: WorkOS OSS harness — cross-repo orchestration, conventions, playbooks, and task dispatch. Use when working across WorkOS open source repos or when you need harness context.
---

# Case — WorkOS OSS Harness

You are operating within the Case harness for WorkOS open source projects.
Humans steer. Agents execute. When agents struggle, fix the harness.

**Case repo**: `/Users/nicknisi/Developer/case`

All paths below are relative to the skill's cache directory. For scripts, tasks, and project manifest, use the case repo path above.

## Rules

- **Always use `AskUserQuestion` tool when asking the user questions.** Do not ask questions in plain text. The tool provides structured options and ensures the user can respond clearly.
- **Always work in feature branches.** Never commit directly to main. Use `claude --worktree` or create a branch before starting work.
- **Always open pull requests.** Never push directly to main. Use `gh pr create` to open a PR for review. The `gh` CLI is available and authenticated.

## Always Load

Read these first for landscape and rules:
- `../../AGENTS.md` — project landscape, navigation, task dispatch overview
- `../../docs/golden-principles.md` — invariants to follow across all repos

## Task Routing

Based on the user's request, load the relevant context:

| If the task involves... | Read... |
| --- | --- |
| The WorkOS CLI | `../../docs/architecture/cli.md` and `../../docs/playbooks/add-cli-command.md` |
| New AuthKit framework integration | `../../docs/architecture/authkit-framework.md` and `../../docs/playbooks/add-authkit-framework.md` |
| Session management (authkit-session) | `../../docs/architecture/authkit-session.md` |
| Skills plugin | `../../docs/architecture/skills-plugin.md` |
| Bug fix in any repo | `../../docs/playbooks/fix-bug.md` |
| Cross-repo change | `../../docs/playbooks/cross-repo-update.md` |
| Commit conventions | `../../docs/conventions/commits.md` |
| Testing standards | `../../docs/conventions/testing.md` |
| PR structure / review | `../../docs/conventions/pull-requests.md` |
| Code style / formatting | `../../docs/conventions/code-style.md` |

## Project Manifest

Full repo metadata (paths, commands, remotes): `/Users/nicknisi/Developer/case/projects.json`

## Task Dispatch

To create a task for async agent execution:

1. Choose template from `/Users/nicknisi/Developer/case/tasks/templates/`
2. Fill in `{placeholder}` fields
3. Save to `/Users/nicknisi/Developer/case/tasks/active/{repo}-{n}-{slug}.md`

Available templates:
- `/Users/nicknisi/Developer/case/tasks/templates/cli-command.md` — add a CLI command
- `/Users/nicknisi/Developer/case/tasks/templates/authkit-framework.md` — new AuthKit framework integration
- `/Users/nicknisi/Developer/case/tasks/templates/bug-fix.md` — fix a bug in any repo
- `/Users/nicknisi/Developer/case/tasks/templates/cross-repo-update.md` — coordinated cross-repo change

Format spec: `/Users/nicknisi/Developer/case/tasks/README.md`

## Working in a Target Repo

Before making changes in any target repo:

1. Create a feature branch (or use `claude --worktree` for isolated work)
2. Read that repo's `CLAUDE.md` or `CLAUDE.local.md` for project-specific instructions
3. Run `/Users/nicknisi/Developer/case/scripts/bootstrap.sh {repo-name}` to verify readiness
4. Follow the repo's PR checklist before opening a PR
5. Run `/Users/nicknisi/Developer/case/scripts/check.sh --repo {repo-name}` to verify conventions

## Improving the Harness

When an agent struggles or produces poor output, the fix goes into case/, not the code:

- Missing pattern? Add to `/Users/nicknisi/Developer/case/docs/architecture/`
- Unclear convention? Update `/Users/nicknisi/Developer/case/docs/conventions/`
- Recurring task? Add a playbook + template in `/Users/nicknisi/Developer/case/`
- Agent violation? Add to `/Users/nicknisi/Developer/case/docs/golden-principles.md` and update `scripts/check.sh`
- Wrong approach? Update the relevant `CLAUDE.md` in the target repo
