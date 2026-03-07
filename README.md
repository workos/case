# Case

A harness for orchestrating AI agent work across WorkOS open source projects.

Inspired by [harness engineering](https://openai.com/index/harness-engineering/) — the discipline of designing environments that let AI agents operate reliably at scale. Humans steer. Agents execute. When agents struggle, fix the harness.

## Quick Start

### Install the plugin

Register case as a Claude Code plugin marketplace and install:

```bash
claude plugin marketplace add /path/to/case
claude plugin install case
```

Restart Claude Code after installing. The `/case` skill will be available in all sessions.

To update after changes to the harness:
```bash
claude plugin update case
```

### Use interactively

Open Claude Code in the case directory and describe what you want:

```bash
cd case/
claude

> Add a "workos widgets list" command to the CLI
> Fix the session refresh bug in authkit-nextjs (issue #42)
> Update all repos to use the latest TypeScript config
```

The agent reads `AGENTS.md` for the project landscape, routes to the right architecture doc and playbook, then goes to the target repo and does the work.

### Use the /case skill

From any of the target repos, invoke the skill:

```bash
cd ../authkit-nextjs/
claude

> /case fix a bug where session cookies aren't being set correctly
```

The skill loads harness context (landscape, conventions, playbooks) so the agent has cross-repo awareness even when working in a single repo.

## Dispatching Tasks

Tasks are markdown files that agents execute. This is how you do fire-and-forget parallel work.

### 1. Pick a template

```bash
ls tasks/templates/
# cli-command.md          — add a CLI command
# authkit-framework.md    — new AuthKit framework integration
# bug-fix.md              — fix a bug in any repo
# cross-repo-update.md    — coordinated cross-repo change
```

### 2. Fill it in

```bash
cp tasks/templates/bug-fix.md tasks/active/authkit-nextjs-1-fix-cookie-bug.md
# Edit the file — fill in {placeholders}
```

### 3. Hand it to an agent

```bash
claude -p "Execute the task in tasks/active/authkit-nextjs-1-fix-cookie-bug.md"
```

Or open Claude Code and point it at the task:

```
> Read and execute tasks/active/authkit-nextjs-1-fix-cookie-bug.md
```

### 4. Run multiple in parallel

Open separate terminals, each running a different task:

```bash
# Terminal 1
claude -p "Execute tasks/active/cli-1-add-widgets.md"

# Terminal 2
claude -p "Execute tasks/active/authkit-nextjs-1-fix-cookie-bug.md"

# Terminal 3
claude -p "Execute tasks/active/x-1-update-readme-badges.md"
```

### 5. Review PRs

Each agent opens a PR in the target repo. Review and merge as usual. After merge, move the task file:

```bash
mv tasks/active/authkit-nextjs-1-fix-cookie-bug.md tasks/done/
```

## Verifying Repos

### Check conventions across all repos

```bash
bash scripts/check.sh
```

Checks each repo against golden principles (CLAUDE.md exists, required commands, conventional commits, file size limits, package.json fields). Outputs PASS/FAIL with remediation instructions.

### Check a single repo

```bash
bash scripts/check.sh --repo cli
```

### Bootstrap a repo for agent work

```bash
bash scripts/bootstrap.sh cli
```

Installs deps, runs tests, runs build. Confirms the repo is ready.

### Run checks with tests

```bash
bash scripts/check.sh --run-tests
```

## What's in the Harness

```
AGENTS.md                         → Entry point for agents (project landscape, navigation)
CLAUDE.md                         → How to improve case itself
projects.json                     → Manifest of target repos (paths, commands, remotes)

docs/
  architecture/
    cli.md                        → CLI adapter pattern, command structure
    authkit-framework.md          → Canonical AuthKit integration pattern
    authkit-session.md            → Session management architecture
    skills-plugin.md              → Skills plugin structure
  conventions/
    commits.md                    → Conventional commits, release-please
    testing.md                    → Test frameworks, coverage, naming
    pull-requests.md              → PR structure, required checks
    code-style.md                 → Formatters, linters, file size limits
  golden-principles.md            → 15 invariants (9 enforced, 6 advisory)
  playbooks/
    add-cli-command.md            → Step-by-step: add a CLI command
    add-authkit-framework.md      → Step-by-step: new AuthKit framework
    fix-bug.md                    → Step-by-step: triage and fix a bug
    cross-repo-update.md          → Step-by-step: coordinated cross-repo change

tasks/
  active/                         → Current tasks for agent execution
  done/                           → Completed tasks
  templates/                      → Fill-in-the-blank task templates
  README.md                       → Task file format spec

scripts/
  check.sh                        → Convention enforcement across repos
  bootstrap.sh                    → Per-repo readiness verification

skills/case/SKILL.md              → /case Claude Code skill
.claude-plugin/plugin.json        → Claude Code plugin manifest
```

## Target Repos (v1)

| Repo | Path | Purpose |
| --- | --- | --- |
| cli | `../cli/main` | WorkOS CLI |
| skills | `../skills` | Claude Code skills plugin |
| authkit-session | `../authkit-session` | Framework-agnostic session management |
| authkit-tanstack-start | `../authkit-tanstack-start` | AuthKit TanStack Start SDK |
| authkit-nextjs | `../authkit-nextjs` | AuthKit Next.js SDK |

The manifest (`projects.json`) and all tooling are designed to scale to 25+ repos. Add a new repo by appending to `projects.json`.

## Philosophy

- **Never write code directly.** Only improve the harness. All code changes flow through agents.
- **When agents struggle, fix the harness.** Missing pattern? Add to `docs/architecture/`. Unclear convention? Update `docs/conventions/`. Recurring task? Add a playbook + template.
- **Give a map, not a manual.** `AGENTS.md` is 47 lines. Agents drill into deeper docs only when needed.
- **Enforce mechanically.** `scripts/check.sh` catches violations automatically. Error messages tell agents how to fix them.

## Relationship to Skills Plugin

- **skills** (`../skills`) = WorkOS domain knowledge (what is SSO, how AuthKit works, API endpoints)
- **case** = orchestration layer (which repos exist, how to work across them, patterns, playbooks)

They're complementary. Case depends on skills for product knowledge.

## Adding a New Repo

1. Add entry to `projects.json` (follow the schema)
2. Ensure the repo has a `CLAUDE.md` with: commands, architecture, do/don't, PR checklist
3. Run `bash scripts/check.sh --repo <name>` to verify compliance
4. Add architecture doc to `docs/architecture/` if the repo introduces a new pattern
5. Update `AGENTS.md` project table
