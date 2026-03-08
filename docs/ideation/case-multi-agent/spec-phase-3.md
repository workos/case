# Implementation Spec: Case Multi-Agent - Phase 3

**Contract**: ./contract.md
**Estimated Effort**: L

## Technical Approach

Phase 3 rewrites the `/case` SKILL.md to function as an **orchestrator** that spawns three subagents (implementer, verifier, closer) instead of executing all work in a single context window. The orchestrator handles argument parsing, issue fetching, task file creation, baseline smoke testing, and subagent dispatch — but never touches code or runs Playwright.

The critical addition is **baseline smoke testing** (inspired by Anthropic's "get up to speed" pattern): before spawning the implementer, the orchestrator runs the target repo's test/build to confirm a clean baseline. This prevents agents from building on broken foundations.

The orchestrator uses the Claude Code `Agent` tool to spawn subagents, passing each agent's prompt file content as the prompt. This matches the pattern used by the ideation plugin's execute-spec (which spawns scout and reviewer agents the same way).

## File Changes

### Modified Files

| File Path | Changes |
|-----------|---------|
| `skills/case/SKILL.md` | Major rewrite: add orchestrator flow with subagent dispatch, baseline smoke test, task JSON creation. Preserve argument parsing, routing table, rules, and verification tools reference. |

## Implementation Details

### Orchestrator SKILL.md Rewrite

**Pattern to follow**: Current `skills/case/SKILL.md` (preserve argument parsing, routing table, rules sections). Ideation's `execute-spec/SKILL.md` (for subagent dispatch pattern at `/Users/nicknisi/.claude/plugins/cache/nicknisi/ideation/0.9.0/skills/execute-spec/`).

**Overview**: The SKILL.md becomes an orchestrator document. It retains existing sections (Arguments, Rules, Always Load, Task Routing, Project Manifest, Verification Tools) but replaces the monolithic execution flow with a phased subagent dispatch.

**Key decisions**:

- **Agent prompt paths are absolute**: The orchestrator reads agent prompt files from `/Users/nicknisi/Developer/case/agents/` (the `agents/` directory at the case repo root, NOT relative to CWD). SKILL.md must use the full absolute path since `/case` runs from target repos, not from the case repo. This matches how SKILL.md already references scripts with absolute paths.
- Each subagent is spawned sequentially (implementer → verifier → closer). No parallelism within a single `/case` run — the pipeline is linear.
- The orchestrator creates both the `.md` task file AND the `.task.json` companion at the same time.
- Baseline smoke test uses `scripts/bootstrap.sh` which already exists and validates repo readiness.
- If any subagent fails or returns an error, the orchestrator stops and reports to the user via `AskUserQuestion`. It does not attempt recovery — the human steers.
- The pre-PR checklist section remains at the end of SKILL.md (for recency bias) but is now labeled as the **closer's responsibility**, not the orchestrator's.
- **Structured subagent output**: Each subagent must end its response with a JSON block that the orchestrator can parse deterministically. No narrative-text parsing. See "Subagent Output Contract" below.
- **Idempotent re-entry**: If `/case` is invoked and a `.task.json` already exists for the current issue (matching repo + issue number), the orchestrator resumes from the last completed agent phase instead of recreating the task. This handles crashed/interrupted runs.

**Subagent Output Contract**:

Every subagent must end its response with a JSON block between exact delimiters `<<<AGENT_RESULT` and `AGENT_RESULT>>>`. No markdown fences, no prose between the delimiters — just the JSON object:

```
<<<AGENT_RESULT
{
  "status": "completed",
  "summary": "one-line description of what happened",
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

**Parsing rule**: The orchestrator searches the subagent's response for text between `<<<AGENT_RESULT` and `AGENT_RESULT>>>`, then `JSON.parse`es it. Fields not relevant to a given agent are `null`/empty. If delimiters not found, treat as failed with error "no structured output — raw response: <first 200 chars>".

**New orchestrator flow** (replaces steps 6-12 in current GitHub issue flow and steps 6-12 in Linear flow):

```
ORCHESTRATOR FLOW
=================

0. CHECK FOR EXISTING TASK (idempotent re-entry)
   - Read .case-active — if it contains a task ID, look up that specific
     /Users/nicknisi/Developer/case/tasks/active/{task-id}.task.json
     directly (fastest, most reliable)
   - If .case-active missing or empty: derive repo name from git remote,
     then match by argument type:
       GitHub issue → scan /Users/nicknisi/Developer/case/tasks/active/*.task.json
                      for matching repo + issueType "github" + issue number
       Linear ID    → scan for matching issueType "linear" + issue ID
       Free text    → no automatic re-entry (ambiguous). Proceed to step 1.
   - If found:
     - Read its status field
     - Resume from the next incomplete phase:
       active → go to step 3 (BRANCH & BASELINE)
       implementing → go to step 4 (SPAWN IMPLEMENTER) if implementer failed,
                      or step 5 (SPAWN VERIFIER) if implementer completed
       verifying → go to step 5 (SPAWN VERIFIER) if verifier failed,
                   or step 6 (SPAWN CLOSER) if verifier completed
       closing → go to step 6 (SPAWN CLOSER)
       pr-opened → report PR already exists, done
     - Skip task creation (step 1-2)
   - If not found: proceed to step 1

1. PARSE & FETCH (unchanged from current SKILL.md)
   - Parse argument type (GitHub issue / Linear ID / free text)
   - Fetch issue details (gh issue view / Linear MCP / user input)
   - Read issue title, body, comments

2. TASK SETUP (updated for new format)
   - Find next sequential task number
   - Create task file (.md) in /Users/nicknisi/Developer/case/tasks/active/ using appropriate template
   - Create companion .task.json in /Users/nicknisi/Developer/case/tasks/active/ with initial values:
     {
       "id": "<repo>-<n>-issue-<number>",
       "status": "active",
       "created": "<ISO timestamp>",
       "repo": "<repo-name>",
       "issue": "<issue-number>",
       "issueType": "github|linear|freeform",
       "branch": "<derived from argument type — see below>",
       "agents": {
         "orchestrator": { "status": "running", "started": "<ISO>" },
         "implementer": { "status": "pending" },
         "verifier": { "status": "pending" },
         "closer": { "status": "pending" }
       },
       "tested": false,
       "manualTested": false,
       "prUrl": null
     }
   - Activate case enforcement: echo "<task-id>" > .case-active
     (Write the task ID into .case-active, not bare touch.
      This enables task-scoped hook targeting.)

3. BRANCH & BASELINE
   - Derive branch name from argument type:
     GitHub issue → fix/issue-<N>  (e.g., fix/issue-53)
     Linear ID   → fix/<ID>       (e.g., fix/DX-1234)
     Free text   → fix/<slug>     (e.g., fix/update-readme)
   - Check if branch already exists: git branch --list <branch>
     If exists: git checkout <branch>  (resume)
     If not: git checkout -b <branch>  (create)
   - Run baseline smoke test:
     bash /Users/nicknisi/Developer/case/scripts/bootstrap.sh <repo-name>
   - If FAIL: stop, report broken baseline, suggest fixing before proceeding
   - If PASS: continue
   - Append to progress log:
     "### Orchestrator — <timestamp>
     - Created task from <issue-type> <issue-ref>
     - Baseline smoke test: PASS
     - Spawning implementer"
   - Update task JSON: orchestrator status → completed

4. SPAWN IMPLEMENTER
   - Read /Users/nicknisi/Developer/case/agents/implementer.md
   - Use Agent tool:
     - prompt: <implementer.md content> + task context (file path, repo path,
       issue summary, playbook)
     - subagent_type: general-purpose
   - Wait for completion
   - Parse AGENT_RESULT JSON from response
   - If status == "failed": stop, report to user via AskUserQuestion
   - If status == "completed": continue

5. SPAWN VERIFIER
   - Read /Users/nicknisi/Developer/case/agents/verifier.md
   - Use Agent tool:
     - prompt: <verifier.md content> + task context (file path, repo path)
     - subagent_type: general-purpose
   - Wait for completion
   - Parse AGENT_RESULT JSON from response
   - If status == "failed":
     - Check if src/ files changed: git diff --name-only main | grep "^src/"
     - If src/ files changed: verification is REQUIRED (pre-PR hook will block)
       Report to user via AskUserQuestion:
         "Verification failed: <summary>"
         Options:
         - "Fix and re-verify" — Spawn implementer again with findings, then re-verify
         - "Abort" — Stop the /case flow
       (No "skip" option — the hook makes it impossible when src/ changed)
     - If NO src/ files changed: verification is optional
       Report to user via AskUserQuestion:
         "Verification failed: <summary>"
         Options:
         - "Fix and re-verify" — Retry
         - "Skip verification" — Proceed (hook won't require manual evidence)
         - "Abort" — Stop

6. SPAWN CLOSER
   - Update task JSON: status → closing
     bash /Users/nicknisi/Developer/case/scripts/task-status.sh <task.json> status closing
   - Read /Users/nicknisi/Developer/case/agents/closer.md
   - Use Agent tool:
     - prompt: <closer.md content> + task context (file path, repo path,
       verifier AGENT_RESULT)
     - subagent_type: general-purpose
   - Wait for completion
   - Parse AGENT_RESULT JSON from response
   - If status == "failed": report to user, suggest which steps to re-run

7. COMPLETE
   - Report PR URL to user
   - Summary: what was done, what was tested, PR link
```

**Sections to preserve from current SKILL.md**:

- `## Arguments` — **update no-arg behavior**: if `.case-active` exists with a task ID, resume that task (re-entry). Otherwise, fall back to current "load harness context" behavior. GitHub issue and Linear ID parsing stay as-is.
- `## Rules` — keep as-is (AskUserQuestion, feature branches, conventional commits, PRs)
- `## Always Load` — keep as-is (AGENTS.md, golden-principles.md)
- `## Task Routing` — keep as-is (routing table)
- `## Project Manifest` — keep as-is
- `## Task Dispatch` — update to reference new format
- `## Working in a Target Repo` — keep as-is
- `## Verification Tools` — keep as-is (Playwright, credentials, screenshot upload, Chrome DevTools)
- `## Improving the Harness` — keep as-is

**Sections to rewrite**:

- The GitHub issue flow (steps 6-12 in current `## Arguments` → GitHub issue number section) → replace with orchestrator flow
- The Linear issue flow (steps 6-12) → replace with orchestrator flow
- The pre-PR checklist → keep content but relabel as "Closer Agent Checklist" with note that the orchestrator spawns the closer, which handles this

**Sections to add**:

- `## Agent Architecture` — brief overview of the four-agent pipeline, reference to agents/ directory at `/Users/nicknisi/Developer/case/agents/`
- `## Subagent Output Contract` — the AGENT_RESULT JSON schema that all subagents must produce
- `## Baseline Smoke Test` — explain the bootstrap.sh check and what to do if it fails
- `## Re-entry Semantics` — how the orchestrator resumes from `.task.json` state if a prior run was interrupted
- `## Orchestrator Flow` — the detailed flow above, replacing the inline execution steps

**Implementation steps**:

1. Read the full current SKILL.md (it's ~270 lines)
2. Read the ideation execute-spec SKILL.md for the subagent dispatch pattern
3. Identify sections to preserve vs. rewrite vs. add
4. Write the new SKILL.md:
   a. Keep frontmatter (name, description, argument-hint)
   b. Keep intro paragraph and case repo path
   c. Rewrite `## Arguments` section: preserve parsing logic, replace execution steps with orchestrator dispatch
   d. Keep `## Rules`, `## Always Load`, `## Task Routing`, `## Project Manifest`
   e. Add `## Agent Architecture` section (overview of pipeline)
   f. Rewrite `## Task Dispatch` to reference new hybrid format
   g. Keep `## Working in a Target Repo`
   h. Keep `## Verification Tools` (verifier agent uses these)
   i. Rewrite pre-PR checklist as closer agent's responsibility
   j. Keep `## Improving the Harness`
5. Verify the orchestrator flow references correct paths for agent prompt files, scripts, and task directories

## Error Handling

| Error Scenario | Handling Strategy |
|---|---|
| Bootstrap smoke test fails | Stop orchestrator. Report broken baseline to user. Suggest fixing before proceeding. Do not spawn implementer. |
| Implementer fails (tests don't pass, can't reproduce bug) | Stop orchestrator. Report implementer's error to user via AskUserQuestion. User decides whether to retry, debug manually, or abort. |
| Verifier fails + src/ changed | Verification is mandatory (hook blocks without it). Options: fix-and-retry or abort. No skip. |
| Verifier fails + no src/ changed | Verification is optional. Options: fix-and-retry, skip, or abort. |
| Closer fails (hooks block PR) | Report missing prerequisites. Suggest which steps to run (mark-tested.sh, mark-manual-tested.sh). User decides next step. |
| Agent prompt file not found | Stop with clear error: "Agent prompt file not found at /Users/nicknisi/Developer/case/agents/{name}.md — is the case plugin installed correctly?" |
| No AGENT_RESULT in subagent response | Treat as failed. Log the raw response for debugging. Report to user. |
| Re-entry: existing task found | Resume from last completed phase. Do not recreate task file or branch. |
| Task JSON companion missing | Orchestrator creates it. If it goes missing mid-flow, recreate with current known state. |

## Testing Requirements

### Manual Testing

- [ ] Read the rewritten SKILL.md and trace the flow for a GitHub issue argument
- [ ] Read the rewritten SKILL.md and trace the flow for a Linear issue argument
- [ ] Verify all agent prompt file paths referenced in SKILL.md are correct
- [ ] Verify all script paths referenced in SKILL.md are correct
- [ ] Verify the pre-PR checklist items are all assigned to the correct agent
- [ ] Verify the Task Routing table still references correct doc paths

## Validation Commands

```bash
# Verify SKILL.md exists and has content
wc -l skills/case/SKILL.md

# Check agent file references are correct
grep "agents/implementer.md" skills/case/SKILL.md && echo "OK: implementer ref" || echo "MISSING: implementer ref"
grep "agents/verifier.md" skills/case/SKILL.md && echo "OK: verifier ref" || echo "MISSING: verifier ref"
grep "agents/closer.md" skills/case/SKILL.md && echo "OK: closer ref" || echo "MISSING: closer ref"

# Check bootstrap.sh reference
grep "bootstrap.sh" skills/case/SKILL.md && echo "OK: bootstrap ref" || echo "MISSING: bootstrap ref"

# Check task-status.sh reference
grep "task-status.sh" skills/case/SKILL.md && echo "OK: task-status ref" || echo "MISSING: task-status ref"

# Verify frontmatter is intact
head -5 skills/case/SKILL.md
```

## Open Items

- [ ] Decide whether the orchestrator should also update the Linear issue status (via MCP) after PR creation, or if the closer handles that
- [ ] Determine if the verifier should have a retry budget (e.g., re-run Playwright up to 2 times on flaky tests) or immediately escalate

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
