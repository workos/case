---
name: case
description: WorkOS OSS harness — cross-repo orchestration, conventions, playbooks, and task dispatch. Use when working across WorkOS open source repos or when you need harness context.
---

# Case — WorkOS OSS Harness

You are operating within the Case harness for WorkOS open source projects.
Humans steer. Agents execute. When agents struggle, fix the harness.

**Case repo**: `/Users/nicknisi/Developer/case`

All paths below are relative to the skill's cache directory. For scripts, tasks, and project manifest, use the case repo path above.

## Arguments

Parse the arguments passed to `/case`. The argument determines the workflow:

**No argument** — `/case`
Load harness context for the current task. Follow the Task Routing table below.

**GitHub issue number** — `/case 34`
1. Detect the current repo from the working directory (`git remote get-url origin`)
2. Fetch the issue: `gh issue view 34 --json title,body,labels,comments`
3. Read the issue title, body, and comments to understand the task
4. **Create a task file** in `/Users/nicknisi/Developer/case/tasks/active/`:
   - Derive repo name from the remote (e.g., `authkit-nextjs`)
   - Find the next sequential number: count existing `{repo}-*.md` files + 1
   - Filename: `{repo}-{n}-issue-{number}.md` (e.g., `authkit-nextjs-1-issue-34.md`)
   - Use the bug-fix template from `/Users/nicknisi/Developer/case/tasks/templates/bug-fix.md`
   - Fill in: objective from issue title/body, target repo, acceptance criteria from issue, checklist from the routed playbook
5. Route to the appropriate playbook based on issue content (bug → fix-bug, feature → architecture doc + playbook)
6. Create a feature branch named after the issue: `git checkout -b fix/issue-34`
7. **Update the task file** checklist as you work — check items off as they're completed
8. Execute the work
9. **Run the pre-PR checklist** (see below) — do NOT open a PR until every item passes
10. Open a PR linking the issue: `gh pr create --body "Closes #34"`
11. **Move the task file** to `/Users/nicknisi/Developer/case/tasks/done/` after PR is opened

**Linear issue ID** — `/case DX-1234`
1. Try the Linear MCP tools first (available via claude.ai integration):
   - Use `mcp__claude_ai_Linear__get_issue` with the issue ID
   - Read title, description, comments, status, and assignee
2. If Linear MCP tools are not available, ask the user to paste the issue details using `AskUserQuestion`
3. Determine the target repo from the issue content or current working directory
4. **Create a task file** in `/Users/nicknisi/Developer/case/tasks/active/`:
   - Derive repo name from the issue content or current working directory
   - Find the next sequential number: count existing `{repo}-*.md` files + 1
   - Filename: `{repo}-{n}-{linear-id}.md` (e.g., `cli-2-DX-1234.md`)
   - Use the appropriate template from `/Users/nicknisi/Developer/case/tasks/templates/`
   - Fill in: objective from Linear issue, target repo, acceptance criteria, checklist from the routed playbook
5. Route to the appropriate playbook based on issue content
6. Create a feature branch: `git checkout -b fix/DX-1234`
7. **Update the task file** checklist as you work — check items off as they're completed
8. Execute the work
9. **Run the pre-PR checklist** (see below) — do NOT open a PR until every item passes
10. Open a PR referencing the Linear issue in the body
11. Update the Linear issue status if MCP tools are available: `mcp__claude_ai_Linear__save_issue`
12. **Move the task file** to `/Users/nicknisi/Developer/case/tasks/done/` after PR is opened

**How to detect argument type:**
- Matches `/^\d+$/` → GitHub issue number (e.g., `34`, `142`)
- Matches `/^[A-Z]+-\d+$/` → Linear issue ID (e.g., `DX-1234`, `AUTH-42`)
- Anything else → treat as a free-form task description, use Task Routing

## Rules

- **Always use `AskUserQuestion` tool when asking the user questions.** Do not ask questions in plain text. The tool provides structured options and ensures the user can respond clearly.
- **Always work in feature branches.** Never commit directly to main. Use `claude --worktree` or create a branch before starting work.
- **Always use conventional commits.** Format: `type(scope): description`. Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. Use `!` for breaking changes (e.g., `feat!:`). See `../../docs/conventions/commits.md` for details.
- **Always open pull requests.** Never push directly to main. Use `gh pr create` to open a PR for review. The `gh` CLI is available and authenticated.
- **PR titles must use conventional commit format.** e.g., `fix(session): handle expired cookies gracefully` or `feat(cli): add widgets list command`.
- **PR descriptions must be thorough.** Include: summary of the change and why, what was tested (unit tests, Playwright, manual), screenshots/video for front-end changes, link to the issue (GitHub or Linear), and any follow-up items or known limitations.

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

## Verification Tools

Use these to verify your work beyond unit tests.

**Preference order for front-end testing: Playwright first.** It runs headless, is scriptable, and produces artifacts (screenshots, video). Only use Chrome DevTools MCP for interactive debugging when Playwright isn't sufficient.

### Playwright (primary for front-end)

Use the `playwright-cli` skill for browser automation. Load it via the Skill tool:

```
Skill: playwright-cli
```

The skill provides `playwright-cli` commands: `open`, `goto`, `click`, `type`, `screenshot`, `snapshot`, and more. Use `Bash(playwright-cli:*)` for all browser interactions.

Quick reference:
```bash
playwright-cli open                          # open browser
playwright-cli goto https://localhost:3000   # navigate
playwright-cli snapshot                      # get page snapshot with refs
playwright-cli click e15                     # click element by ref
playwright-cli type "user@example.com"       # type text
playwright-cli screenshot --path /tmp/screenshot.png  # capture
```

### Test credentials

Credentials for testing sign-in flows are at `~/.config/case/credentials`. Read this file to get test values.

Expected keys:
```
WORKOS_API_KEY=sk_test_...
WORKOS_CLIENT_ID=client_...
TEST_USER_EMAIL=test@example.com
TEST_USER_PASSWORD=...
WORKOS_COOKIE_PASSWORD=... (32+ chars for session encryption)
```

Use these when testing auth flows with Playwright:
1. Start the example app (e.g., `cd ../authkit-nextjs/examples/... && pnpm dev`)
2. Navigate to the sign-in page
3. Fill in test credentials from `~/.config/case/credentials`
4. Verify the redirect, session cookie, and authenticated state
5. Capture before/after screenshots

**NEVER commit credentials. NEVER include credential values in PR descriptions, logs, or task files.**

### PR verification artifacts

When making front-end changes, **attach visual proof to the PR description**:

- **Screenshot**: Capture before (on main) and after (on your branch) for comparison
- **Video**: Record the flow for interactive changes (sign-in, navigation, animations)

Upload artifacts to the PR:
```bash
# Upload image and get markdown for PR body
gh pr edit {pr-number} --body "$(cat <<'BODY'
## Summary
{description}

## Visual verification
### Before
![before](/tmp/before.png)

### After
![after](/tmp/after.png)
BODY
)"

# Or attach files directly if the repo supports it
# Take screenshot, encode as base64, embed in PR comment
```

Note: GitHub PR descriptions support image URLs but not direct file uploads from CLI. For local screenshots, upload to a GitHub issue comment first (`gh issue comment` with drag-drop) or use a gist, then reference the URL in the PR body.

### Chrome DevTools MCP (secondary — interactive debugging only)

Use when Playwright isn't sufficient — e.g., inspecting live state, debugging network requests, or exploring an unfamiliar UI. Not for automated verification.

### Example apps

Some repos include example apps for end-to-end testing:
- `../authkit-nextjs/examples/` — Next.js app wired to AuthKit

### When to use which
- Unit tests → always, for logic verification
- **Playwright → front-end changes, auth flows, redirects, cookie behavior, visual verification (preferred)**
- Chrome DevTools MCP → interactive debugging only, when Playwright can't answer the question
- Example apps → for end-to-end auth flow testing with real credentials

## STOP — Pre-PR Checklist (mandatory)

**You MUST complete every applicable item below BEFORE running `gh pr create`. This is a hard gate.**

If you are about to open a PR, stop and verify each item:

- [ ] **Unit tests pass** — run the repo's test command
- [ ] **Types check** — run typecheck if the repo has one
- [ ] **Lint passes** — run lint if the repo has one
- [ ] **Build succeeds** — run build if the repo has one
- [ ] **Example app tested — the SPECIFIC fix, not just the happy path.** If the repo has an example app AND the change touches any `src/` file: start the example app, load the `playwright-cli` skill, and reproduce the exact scenario the issue describes. For a bug fix, trigger the bug conditions and confirm the fix works. For a feature, exercise the new feature specifically. Do NOT just sign in and sign out — that's the happy path, not your fix. Ask yourself: "if I reverted my change, would this test fail?" If the answer is no, you're testing the wrong thing. Use credentials from `~/.config/case/credentials`. Skip ONLY for purely docs/config/CI changes.
- [ ] **Document verification of the SPECIFIC fix.** In the PR description, write what you tested, how you triggered the bug/feature, and what you observed. For a bug fix: describe the behavior BEFORE and AFTER. Be specific — "I triggered a token refresh error by letting the session expire, and confirmed the error no longer throws a 500." Screenshots are ideal but GitHub's API doesn't support image uploads — if you find a way to attach them, do so. Skip ONLY for pure backend/CLI/types-only changes.
- [ ] **Security audit** — if the change touches authentication, session management, token handling, cookie logic, middleware, or any code that enforces access control: load the `security-auditor` skill via the Skill tool and run it against the changed files. Address any critical or high findings before proceeding. Skip for changes that don't touch auth/security boundaries.
- [ ] **Task file updated** — all checklist items in the task file are checked off
- [ ] **Conventional commit** — commit messages follow `type(scope): description`
- [ ] **PR description drafted** — includes: summary, what was tested, screenshots/video (if applicable), issue link, follow-ups

**Do not skip this. Do not "come back to it." Complete it now, before `gh pr create`.**

## Improving the Harness

When an agent struggles or produces poor output, the fix goes into case/, not the code:

- Missing pattern? Add to `/Users/nicknisi/Developer/case/docs/architecture/`
- Unclear convention? Update `/Users/nicknisi/Developer/case/docs/conventions/`
- Recurring task? Add a playbook + template in `/Users/nicknisi/Developer/case/`
- Agent violation? Add to `/Users/nicknisi/Developer/case/docs/golden-principles.md` and update `scripts/check.sh`
- Wrong approach? Update the relevant `CLAUDE.md` in the target repo
