---
name: case
description: WorkOS OSS harness — cross-repo orchestration, conventions, playbooks, and task dispatch. Use when working across WorkOS open source repos or when you need harness context.
argument-hint: '[issue-number] or [LINEAR-ID]'
---

# Case — WorkOS OSS Harness

You are operating within the Case harness for WorkOS open source projects.
Humans steer. Agents execute. When agents struggle, fix the harness.

**Case repo**: `/Users/nicknisi/Developer/case`

All paths below are relative to the skill's cache directory. For scripts, tasks, and project manifest, use the case repo path above.

## Agent Architecture

Case uses a **six-agent pipeline** to prevent context pollution and enable self-improvement. Each agent has a focused context window and a single responsibility:

| Agent                  | Responsibility                                                                 | Tools                               |
| ---------------------- | ------------------------------------------------------------------------------ | ----------------------------------- |
| **Orchestrator** (you) | Parse issue, create task, baseline smoke test, spawn subagents                 | ask_user_question, Agent, Read, Bash  |
| **Implementer**        | Write code, run unit tests, commit (with WIP checkpoints), read repo learnings | Read, Edit, Write, Bash, Glob, Grep |
| **Verifier**           | Manual testing with Playwright, evidence markers, screenshots                  | Read, Bash, Glob, Grep              |
| **Reviewer**           | Review diff against golden principles, classify findings, gate PR creation     | Read, Bash, Glob, Grep              |
| **Closer**             | Create PR with thorough description, verify evidence gates, post review comments  | Read, Bash, Glob, Grep              |
| **Retrospective**      | Propose harness improvements, apply per-repo learnings directly                | Read, Edit, Write, Bash, Glob, Grep |

Agent prompt files: `/Users/nicknisi/Developer/case/agents/{implementer,verifier,reviewer,closer,retrospective}.md`

The orchestrator spawns each agent sequentially using the `Agent` tool, passing the agent prompt file content as the prompt. Each agent ends its response with a structured `AGENT_RESULT` block (see below).

## Subagent Output Contract

Every subagent ends its response with a JSON block between exact delimiters:

```
<<<AGENT_RESULT
{
  "status": "completed",
  "summary": "one-line description",
  "artifacts": {
    "commit": "abc123",
    "filesChanged": ["src/x.ts"],
    "testsPassed": true,
    "screenshotUrls": [],
    "evidenceMarkers": [],
    "prUrl": null,
    "prNumber": null
  },
  "error": null
}
AGENT_RESULT>>>
```

**Parsing**: Search response for text between `<<<AGENT_RESULT` and `AGENT_RESULT>>>`, then parse as JSON. Fields not relevant to a given agent are `null`/empty. If delimiters not found, treat as failed with error "no structured output — raw response: <first 200 chars>".

## Arguments

Parse the arguments passed to `/case`. The argument determines the workflow:

**No argument** — `/case`

1. Check if `.case-active` exists with a task ID → if so, resume that task (see Re-entry Semantics below)
2. Otherwise, load harness context for the current task. Follow the Task Routing table below.

**GitHub issue number** — `/case 34`

1. Detect the current repo from the working directory (`git remote get-url origin`)
2. Fetch the issue: `gh issue view 34 --json title,body,labels,comments`
3. Read the issue title, body, and comments to understand the task
4. Run the **Orchestrator Flow** below (steps 0-7)

**Linear issue ID** — `/case DX-1234`

1. Try the Linear MCP tools first (available via claude.ai integration):
   - Use `mcp__claude_ai_Linear__get_issue` with the issue ID
   - Read title, description, comments, status, and assignee
2. If Linear MCP tools are not available, ask the user to paste the issue details using `ask_user_question`
3. Determine the target repo from the issue content or current working directory
4. Run the **Orchestrator Flow** below (steps 0-7)

**How to detect argument type:**

- Matches `/^\d+$/` → GitHub issue number (e.g., `34`, `142`)
- Matches `/^[A-Z]+-\d+$/` → Linear issue ID (e.g., `DX-1234`, `AUTH-42`)
- Anything else → treat as a free-form task description, use Task Routing

## Orchestrator Flow

After parsing and fetching the issue, execute this pipeline:

### Step 0: Check for Existing Task (Re-entry)

**Explicit arguments always win over `.case-active`.** The `.case-active` shortcut is only used for no-arg `/case`. When an explicit issue number or Linear ID is provided, re-entry is matched by issue content, not by `.case-active`.

1. **If an explicit argument was provided** (issue number or Linear ID):
   - Scan `/Users/nicknisi/Developer/case/tasks/active/*.task.json` for a match:
     - GitHub issue → matching `repo` + `issueType: "github"` + `issue` number
     - Linear ID → matching `issueType: "linear"` + `issue` ID
   - Ignore `.case-active` — it may be stale or from a different issue
   - If found and matches the argument → resume (see status table below)
   - If not found → proceed to step 1 (new task)

2. **If no argument** (`/case` with no args):
   - Read `.case-active` — if it contains a task ID, look up `/Users/nicknisi/Developer/case/tasks/active/{task-id}.task.json` directly
   - If found → check `issueType`:
     - **If `"ideation"`**: Do NOT resume here. Report to user: "This task was created by `/case:from-ideation`. Resume with: `/case:from-ideation {contractPath}`" and stop.
     - **Otherwise**: resume (see status table below)
   - If not found → load harness context (no orchestrator flow)

3. **Free text argument**: no automatic re-entry. Proceed to step 1.

**Resume status table** (when an existing task is found):

- `active` → go to step 3 (Branch & Baseline)
- `implementing` → step 4 (Implementer) if implementer failed, step 5 (Verifier) if implementer completed
- `verifying` → step 5 (Verifier) if verifier failed, step 6 (Reviewer) if verifier completed
- `reviewing` → step 6 (Reviewer) if reviewer failed/blocked, step 7 (Closer) if reviewer completed
- `closing` → step 7 (Closer)
- `pr-opened` → report "PR already exists" and done

If not found → proceed to step 1

### Step 1: Parse & Fetch

_(Already done in the Arguments section above)_

### Step 2: Task Setup

1. Derive repo name from `git remote get-url origin`
2. Find next sequential task number: count existing `{repo}-*.md` files in `/Users/nicknisi/Developer/case/tasks/active/` + 1
3. Create task file (`.md`) using the appropriate template from `/Users/nicknisi/Developer/case/tasks/templates/`
4. Create companion `.task.json` in `/Users/nicknisi/Developer/case/tasks/active/`:
   ```json
   {
     "id": "<repo>-<n>-issue-<number>",
     "status": "active",
     "created": "<ISO timestamp>",
     "repo": "<repo-name>",
     "issue": "<issue-number>",
     "issueType": "github|linear|freeform",
     "branch": "<branch-name>",
     "agents": {
       "orchestrator": { "status": "running", "started": "<ISO>" },
       "implementer": { "status": "pending" },
       "verifier": { "status": "pending" },
       "reviewer": { "status": "pending" },
       "closer": { "status": "pending" }
     },
     "tested": false,
     "manualTested": false,
     "prUrl": null
   }
   ```
5. Activate case enforcement — write the task ID (not bare touch):
   ```bash
   echo "<task-id>" > .case-active
   ```

### Step 3: Branch & Baseline

1. Derive branch name from argument type and issue kind:
   - Determine prefix from issue labels/title: use `feat/` for feature requests, `fix/` for bugs, `chore/` for maintenance. Default to `fix/` if unclear.
   - GitHub issue → `{prefix}/issue-<N>` (e.g., `fix/issue-53`, `feat/issue-364`)
   - Linear ID → `{prefix}/<ID>` (e.g., `fix/DX-1234`)
   - Free text → `{prefix}/<slug>` (e.g., `fix/update-readme`)
2. Check if branch exists: `git branch --list <branch>`
   - Exists → `git checkout <branch>` (resume)
   - Not exists → `git checkout -b <branch>` (create)
3. Run baseline smoke test:

   ```bash
   bash /Users/nicknisi/Developer/case/scripts/bootstrap.sh <repo-name>
   ```

   - If FAIL: Report broken baseline to user via `ask_user_question`. Do not spawn implementer. **Go to step 9 (Retrospective)** with outcome "failed" and failed agent "orchestrator/baseline".
   - If PASS: continue

4. Append to task file progress log:

   ```markdown
   ### Orchestrator — <timestamp>

   - Created task from <issue-type> <issue-ref>
   - Baseline smoke test: PASS
   - Spawning implementer
   ```

5. Update task JSON:
   ```bash
   bash /Users/nicknisi/Developer/case/scripts/task-status.sh <task.json> agent orchestrator status completed
   bash /Users/nicknisi/Developer/case/scripts/task-status.sh <task.json> agent orchestrator completed now
   ```

### Step 3b. Dispatch to Orchestrator

Run the TypeScript orchestrator for the remainder of the pipeline (Steps 4-9):

```bash
bun /Users/nicknisi/Developer/case/src/index.ts --task <task.json path> --mode attended
```

The orchestrator handles Steps 4-9 deterministically via a while/switch loop. If it exits with code 0, the pipeline is complete. If it exits with code 1, check the task JSON and run log for failure details.

**When to use this vs the manual steps below:**

- **Prefer the orchestrator** — it provides deterministic flow control, hard-capped retries, and role-specific context assembly.
- **Fall back to manual steps** — if the orchestrator is unavailable or you need fine-grained control (e.g., debugging a specific phase).

The manual Steps 4-9 below remain as documentation and fallback.

---

### Step 4: Spawn Implementer

1. Read `/Users/nicknisi/Developer/case/agents/implementer.md`
2. Use the `Agent` tool:
   - **prompt**: `<implementer.md content>` + task context:
     - Task file path (`.md` and `.task.json`)
     - Working memory path (`{task-stem}.working.md` — may not exist on first run)
     - Target repo path
     - Issue summary (title, body, key details)
     - Playbook path from Task Routing
   - **subagent_type**: `general-purpose`
3. Wait for completion
4. Parse `AGENT_RESULT` from response
5. If `status == "failed"`: **attempt intelligent respawn** (step 4b) before surfacing to user.
6. If `status == "completed"`: continue to step 5

### Step 4b: Intelligent Respawn (on implementer failure)

One targeted retry is worth more than three identical retries. Analyze the failure and retry once with adjusted context before surfacing to the user.

1. Run failure analysis:
   ```bash
   ANALYSIS=$(bash /Users/nicknisi/Developer/case/scripts/analyze-failure.sh <task.json> implementer "<error from AGENT_RESULT>")
   echo "$ANALYSIS"
   ```
2. Parse the JSON output. Check `retryViable`:
   - If `false` → skip retry, go to step 4c (surface to user)
   - If `true` → continue with retry
3. Respawn the implementer with adjusted context. Prepend this to the original prompt:

   ```
   ## RETRY CONTEXT — Previous attempt failed

   **Failure class:** {failureClass}
   **Error:** {errorSummary}
   **What was already tried:** {whatWasTried — list items}
   **Suggested focus:** {suggestedFocus}

   Do NOT repeat the previous approach. Read your working memory ({task-stem}.working.md)
   for details on what was tried. Focus on the suggested approach above.
   ```

   Use the `Agent` tool with the adjusted prompt. Same subagent_type.

4. Parse the retry's `AGENT_RESULT`:
   - If `status == "completed"` → continue to step 5 (Verifier)
   - If `status == "failed"` → go to step 4c (surface to user)

**Rule: maximum 1 intelligent retry per pipeline run.** Do not retry again after the retry fails.

### Step 4c: Surface Implementer Failure to User

Report the failure to user via `ask_user_question`:

- Include both the original error and the retry result (if retry was attempted)
- Options: "Re-run with guidance" | "Abort"
- If "Abort": **go to step 9 (Retrospective)** with outcome "failed" and failed agent "implementer".

### Step 5: Spawn Verifier

1. Read `/Users/nicknisi/Developer/case/agents/verifier.md`
2. Use the `Agent` tool:
   - **prompt**: `<verifier.md content>` + task context (file path, repo path)
   - **subagent_type**: `general-purpose`
3. Wait for completion
4. Parse `AGENT_RESULT` from response
5. If `status == "failed"`:
   - Check if `src/` files changed: `git diff --name-only main | grep "^src/"`
   - **If src/ changed** (verification mandatory — closer must verify):
     Use `ask_user_question`: "Verification failed: `<summary>`"
     Options: "Fix and re-verify" | "Abort"
     If "Abort": **go to step 9 (Retrospective)** with outcome "failed" and failed agent "verifier".
   - **If NO src/ changed** (verification optional):
     Use `ask_user_question`: "Verification failed: `<summary>`"
     Options: "Fix and re-verify" | "Skip verification" | "Abort"
     If "Abort": **go to step 9 (Retrospective)** with outcome "failed" and failed agent "verifier".
6. If `status == "completed"`: continue to step 6

### Step 6: Spawn Reviewer

1. Read `/Users/nicknisi/Developer/case/agents/reviewer.md`
2. Use the `Agent` tool:
   - **prompt**: `<reviewer.md content>` + task context:
     - Task file path (`.md` and `.task.json`)
     - Target repo path
   - **subagent_type**: `general-purpose`
3. Wait for completion
4. Parse `AGENT_RESULT` from response
5. If `status == "blocked"` (critical findings):
   - Report critical findings to user via `ask_user_question`:
     "Reviewer found `<N>` critical finding(s): `<details>`"
     Options: "Re-implement and re-review" | "Override and continue" | "Abort"
     If "Re-implement and re-review": **go to step 4 (Implementer)** to address the findings, then re-run verifier and reviewer.
     If "Override and continue": continue to step 7 (Closer). Note: the closer still requires `.case-reviewed` — the user must manually create the marker or address the findings.
     If "Abort": **go to step 9 (Retrospective)** with outcome "failed" and failed agent "reviewer".
6. If `status == "completed"` (no critical findings): continue to step 7

### Step 7: Spawn Closer

1. Update task JSON status to `closing`:
   ```bash
   bash /Users/nicknisi/Developer/case/scripts/task-status.sh <task.json> status closing
   ```
2. Read `/Users/nicknisi/Developer/case/agents/closer.md`
3. Use the `Agent` tool:
   - **prompt**: `<closer.md content>` + task context (file path, repo path, verifier `AGENT_RESULT`, reviewer `AGENT_RESULT`)
   - **subagent_type**: `general-purpose`
4. Wait for completion
5. Parse `AGENT_RESULT` from response
6. If `status == "failed"`: report to user, suggest which steps to re-run. **Go to step 9 (Retrospective)** with outcome "failed" and failed agent "closer".
7. If `status == "completed"`: continue to step 8

### Step 8: Complete

1. Report to user:
   - PR URL from closer's `AGENT_RESULT`
   - Summary: what was done (from implementer), what was tested (from verifier), what was reviewed (from reviewer), PR link (from closer)

### Step 9: Spawn Retrospective

**Always runs** — after both successful and failed pipelines, at every failure class (baseline, implementer, verifier, reviewer, closer). Every failure branch in steps 3-8 routes here explicitly. This is how the harness improves itself.

1. Read `/Users/nicknisi/Developer/case/agents/retrospective.md`
3. Use the `Agent` tool:
   - **prompt**: `<retrospective.md content>` + context:
     - Task file path (with progress log from all agents)
     - Task JSON path (with agent phases and timing)
     - Pipeline outcome: "completed" or "failed"
     - If failed: which agent failed and its AGENT_RESULT error
   - **subagent_type**: `general-purpose`
4. The retrospective agent **proposes amendments** to `docs/proposed-amendments/` for human review. Only repo learnings (`docs/learnings/`) are applied directly.
5. When the agent completes, report to the user:
   ```
   "Retrospective proposed <N> amendment(s): <summary>"
   ```
   Include the list of proposed amendment files from the AGENT_RESULT artifacts.

**The retrospective is awaited.** It runs after the PR is created and completes before the pipeline exits. If it fails or produces no proposals, the `/case` run is still complete.

## Re-entry Semantics

If `/case` is invoked and a `.task.json` already exists for the issue, the orchestrator resumes from the last completed agent phase instead of recreating everything. This handles crashed or interrupted runs.

**Explicit arguments win.** When `/case 53` or `/case DX-1234` is invoked, re-entry is matched by scanning `.task.json` files for the specific issue — `.case-active` is ignored (it may be stale or from a different issue).

**No-arg `/case`** uses `.case-active` as a convenience shortcut to resume the most recent task.

**Free-form tasks**: No automatic re-entry (ambiguous). User can resume by running `/case` with no arguments from the same branch — the `.case-active` marker routes them.

## Baseline Smoke Test

Before spawning the implementer, the orchestrator runs the target repo's test/build suite to confirm a clean baseline. This prevents agents from building on broken foundations.

```bash
bash /Users/nicknisi/Developer/case/scripts/bootstrap.sh <repo-name>
```

The bootstrap script runs the repo's `setup`, `build`, `test`, `typecheck`, and `lint` commands (from `projects.json`). If any fail:

- **Stop the orchestrator.** Do not spawn the implementer.
- Report the failure to the user via `ask_user_question`
- Suggest fixing the baseline before retrying `/case`

This is embedded in Step 3 of the Orchestrator Flow but documented here for clarity.

## Rules

- **Always use `ask_user_question` tool when asking the user questions.** Do not ask questions in plain text. The tool provides structured options and ensures the user can respond clearly.
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

| If the task involves...              | Read...                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| The WorkOS CLI                       | `../../docs/architecture/cli.md` and `../../docs/playbooks/add-cli-command.md`                     |
| New AuthKit framework integration    | `../../docs/architecture/authkit-framework.md` and `../../docs/playbooks/add-authkit-framework.md` |
| Session management (authkit-session) | `../../docs/architecture/authkit-session.md`                                                       |
| Skills plugin                        | `../../docs/architecture/skills-plugin.md`                                                         |
| Bug fix in any repo                  | `../../docs/playbooks/fix-bug.md`                                                                  |
| Feature request in any repo          | `../../docs/playbooks/add-feature.md`                                                              |
| Cross-repo change                    | `../../docs/playbooks/cross-repo-update.md`                                                        |
| Ideation contract                    | Use `/case:from-ideation <folder>` instead — separate skill for ideation-sourced work              |
| Commit conventions                   | `../../docs/conventions/commits.md`                                                                |
| Testing standards                    | `../../docs/conventions/testing.md`                                                                |
| PR structure / review                | `../../docs/conventions/pull-requests.md`                                                          |
| Code style / formatting              | `../../docs/conventions/code-style.md`                                                             |

## Project Manifest

Full repo metadata (paths, commands, remotes): `/Users/nicknisi/Developer/case/projects.json`

## Task Dispatch

To create a task for async agent execution:

1. Choose template from `/Users/nicknisi/Developer/case/tasks/templates/`
2. Fill in `{placeholder}` fields
3. Save `.md` to `/Users/nicknisi/Developer/case/tasks/active/{repo}-{n}-{slug}.md`
4. Create companion `.task.json` with the same stem (see task schema: `/Users/nicknisi/Developer/case/tasks/task.schema.json`)
5. Update task JSON status as agents complete work via `/Users/nicknisi/Developer/case/scripts/task-status.sh`

Available templates:

- `/Users/nicknisi/Developer/case/tasks/templates/cli-command.md` — add a CLI command
- `/Users/nicknisi/Developer/case/tasks/templates/authkit-framework.md` — new AuthKit framework integration
- `/Users/nicknisi/Developer/case/tasks/templates/bug-fix.md` — fix a bug in any repo
- `/Users/nicknisi/Developer/case/tasks/templates/cross-repo-update.md` — coordinated cross-repo change
- `/Users/nicknisi/Developer/case/tasks/templates/ideation-project.md` — implement an ideation contract (used by `/case:from-ideation`)

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
playwright-cli video-start                   # start recording (before navigating)
playwright-cli goto https://localhost:3000   # navigate
playwright-cli snapshot                      # get page snapshot with refs
playwright-cli click e15                     # click element by ref
playwright-cli type "user@example.com"       # type text
playwright-cli screenshot                    # capture screenshot (saves to .playwright-cli/)
playwright-cli video-stop /tmp/verify.webm   # stop recording and save video
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

**NEVER commit credentials. NEVER include credential values in PR descriptions, logs, or task files. NEVER use credentials in raw curl/API calls — only pass them through example app .env files.**

### PR verification artifacts

When making front-end changes, **attach visual proof to the PR description**:

- **Screenshot**: Capture before (on main) and after (on your branch) for comparison
- **Video**: Record the flow for interactive changes (sign-in, navigation, animations)

Upload screenshots and video to the case-assets repo and get markdown for PR bodies:

```bash
# Record the full verification flow as video
playwright-cli video-start
# ... run the test flow (goto, click, fill, verify) ...
playwright-cli video-stop /tmp/verification.webm

# Capture a final screenshot
playwright-cli screenshot
cp .playwright-cli/page-*.png /tmp/after.png

# Upload and get markdown
# For video: the script auto-converts to GIF (inline) + mp4 (download link)
VIDEO=$(/Users/nicknisi/Developer/case/scripts/upload-screenshot.sh /tmp/verification.webm)
SCREENSHOT=$(/Users/nicknisi/Developer/case/scripts/upload-screenshot.sh /tmp/after.png)

# Use in PR body — VIDEO contains both GIF embed and mp4 download link
echo "## Verification"
echo "### Video"
echo "$VIDEO"
echo "### Screenshot"
echo "$SCREENSHOT"
```

**Why GIF?** GitHub only renders inline videos from `user-attachments` URLs (uploaded via the web UI). There's no API for that. The upload script converts video to animated GIF (renders inline from release assets) and also uploads the mp4 as a full-quality download link.

The upload script returns `<video src="url" controls></video>` for video files and `![filename](url)` for images. Both render inline in GitHub PR descriptions.

The verifier agent handles screenshot capture. The closer agent uses the uploaded markdown in the PR description.

The upload script pushes images to `workos/case-assets` as release assets and returns a markdown image tag with the download URL.

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

## STOP — Closer Agent Checklist (mandatory)

**The closer agent MUST verify every applicable item below BEFORE running `gh pr create`. The pre-PR the closer verifies this before PR creation.**

The orchestrator spawns the closer, which handles this checklist. If you're the orchestrator, do NOT execute these items yourself — the closer agent does.

- [ ] **Unit tests pass** — implementer ran and committed passing tests
- [ ] **Types check** — implementer ran typecheck
- [ ] **Lint passes** — implementer ran lint
- [ ] **Build succeeds** — implementer ran build
- [ ] **Test evidence exists**: `.case-tested` with `output_hash` (created by implementer via `mark-tested.sh`)
- [ ] **Manual testing done** (if src/ files changed): `.case-manual-tested` with `evidence` (created by verifier via `mark-manual-tested.sh`)
- [ ] **Screenshots captured and uploaded** (if front-end changes): verifier captured via Playwright and uploaded via `upload-screenshot.sh`
- [ ] **Code review passed**: `.case-reviewed` with `critical: 0` (created by reviewer via `mark-reviewed.sh`)
- [ ] **Security audit** — if the change touches authentication, session management, token handling, cookie logic, middleware, or any code that enforces access control: load the `security-auditor` skill via the Skill tool and run it against the changed files. Address any critical or high findings before proceeding. Skip for changes that don't touch auth/security boundaries.
- [ ] **Task file progress log updated** — all agents appended their entries
- [ ] **Conventional commit** — implementer used `type(scope): description`
- [ ] **PR description drafted** — includes: summary, what was tested, verification notes, screenshots, issue link, follow-ups

**The closer MUST verify all evidence markers exist before attempting `gh pr create`.**

## Improving the Harness

When an agent struggles or produces poor output, the fix goes into case/, not the code:

- Missing pattern? Add to `/Users/nicknisi/Developer/case/docs/architecture/`
- Unclear convention? Update `/Users/nicknisi/Developer/case/docs/conventions/`
- Recurring task? Add a playbook + template in `/Users/nicknisi/Developer/case/`
- Agent violation? Add to `/Users/nicknisi/Developer/case/docs/golden-principles.md` and update `scripts/check.sh`
- Wrong approach? Update the relevant `CLAUDE.md` in the target repo
