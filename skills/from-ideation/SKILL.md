---
name: from-ideation
description: Execute an ideation contract through the case pipeline. Reads a contract folder, runs each spec phase through the implementer, then verifier → reviewer → closer for a single PR covering the entire contract.
argument-hint: "<ideation-folder-path>"
---

# Execute Ideation Contract

Run an ideation contract's specs through the case pipeline. All phases execute on one branch — one PR covers the entire contract.

**Case repo**: `/Users/nicknisi/Developer/case`

## Arguments: $ARGUMENTS

Parse the argument as a path to an ideation folder containing `contract.md` and one or more spec files.

**If no argument**: Search for ideation folders:
```bash
ls ./docs/ideation/*/contract.md 2>/dev/null
```
If multiple found, use `AskUserQuestion` to select one. If none found, report error.

## Pipeline Overview

```
Read contract → Create task → Branch & baseline
    → For each phase: spawn implementer (with spec)
    → Full validation → Verifier → Reviewer → Closer → PR
```

One branch. One PR. Phases commit sequentially. Verification and review cover the combined diff.

## Step 0: Load Contract

1. Read `{ideation-folder}/contract.md`
2. Extract these sections (retain for task creation):
   - **Problem Statement** + **Goals** → task objective
   - **Success Criteria** → task acceptance criteria
   - **Execution Plan** → phase ordering (informational — used to understand dependencies but execution is always sequential)

3. Discover spec files in the folder:
   ```
   {folder}/spec.md                    # single-phase project (no phase number)
   {folder}/spec-phase-*.md            # multi-phase project
   {folder}/spec-template-*.md         # repeatable pattern template (read alongside delta specs)
   ```

4. Sort specs by phase number (extract N from `spec-phase-N.md`). Single-phase projects have just `spec.md`.

5. Read each spec's first few lines to extract its title/purpose for the task checklist.

## Step 1: Task Setup

1. Determine **project name** from the ideation folder path (last directory segment, e.g., `bookmarks` from `docs/ideation/bookmarks/`)

2. Determine **target repo** from the current working directory:
   ```bash
   basename $(git remote get-url origin) .git
   ```

3. Find next task number: count existing `{repo}-*.md` files in `/Users/nicknisi/Developer/case/tasks/active/` + 1

4. Create task file (`.md`) from the ideation project template (`/Users/nicknisi/Developer/case/tasks/templates/ideation-project.md`):
   - Fill mission summary from contract problem statement
   - Map success criteria → acceptance criteria checkboxes
   - List all spec files in the Specs section
   - Generate per-phase checklist items

5. Create companion `.task.json` in `/Users/nicknisi/Developer/case/tasks/active/`:
   ```json
   {
     "id": "{repo}-{n}-{project-name}",
     "status": "active",
     "created": "{ISO timestamp}",
     "repo": "{repo-name}",
     "issueType": "ideation",
     "branch": "feat/{project-name}",
     "contractPath": "{ideation-folder}/contract.md",
     "agents": {
       "orchestrator": { "status": "running", "started": "{ISO}" },
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

6. Activate case enforcement:
   ```bash
   echo "{task-id}" > .case-active
   ```

## Step 2: Branch & Baseline

1. Create branch:
   ```bash
   git checkout -b feat/{project-name}
   ```

2. Run baseline:
   ```bash
   bash /Users/nicknisi/Developer/case/scripts/bootstrap.sh {repo-name}
   ```
   - **FAIL**: Report to user via `AskUserQuestion`. Do not proceed.
   - **PASS**: Continue

3. Update task JSON:
   ```bash
   bash /Users/nicknisi/Developer/case/scripts/task-status.sh {task.json} agent orchestrator status completed
   bash /Users/nicknisi/Developer/case/scripts/task-status.sh {task.json} agent orchestrator completed now
   ```

4. Append to task progress log:
   ```markdown
   ### Orchestrator — {timestamp}
   - Created task from ideation contract: {contract-path}
   - Phases: {count} ({list of phase titles})
   - Baseline smoke test: PASS
   - Beginning phase execution
   ```

## Step 3: Execute Phases

Update task status:
```bash
bash /Users/nicknisi/Developer/case/scripts/task-status.sh {task.json} status implementing
bash /Users/nicknisi/Developer/case/scripts/task-status.sh {task.json} agent implementer status running
bash /Users/nicknisi/Developer/case/scripts/task-status.sh {task.json} agent implementer started now
```

### For each spec file (in phase order):

#### 3a. Prepare Context

- Read the spec file fully
- If spec references a template (`spec-template-*.md`), read that too
- Note which phase this is (e.g., "Phase 2 of 3")

#### 3b. Spawn Implementer

1. Read `/Users/nicknisi/Developer/case/agents/implementer.md`

2. Use the `Agent` tool:
   - **description**: "Implement phase {N}"
   - **subagent_type**: `general-purpose`
   - **prompt**: The full implementer.md content (from the Read above), followed by:

   ```
   ## Task Context

   - **Task file**: {task.md path}
   - **Task JSON**: {task.json path}
   - **Target repo**: {absolute repo path}
   - **Playbook**: /Users/nicknisi/Developer/case/docs/playbooks/implement-from-spec.md
   - **Spec file**: {spec file path}
   - **Spec template** (if applicable): {template path}
   - **Phase**: {N} of {total} — {phase title}
   - **Previous phases**: {list of already-completed phases, or "none"}

   Read the playbook first. It tells you how to consume the spec file —
   feedback loops, component-by-component implementation, validation commands.
   The spec file is your implementation guide, not an issue or bug report.
   ```

3. Wait for completion

4. Parse `AGENT_RESULT` from response (see Subagent Output Contract in case SKILL.md)

5. **If failed**:
   - Report to user via `AskUserQuestion`:
     ```
     "Phase {N} implementer failed: {error summary}"
     Options: "Retry this phase" | "Skip and continue" | "Abort"
     ```
   - "Retry": re-spawn implementer for this phase
   - "Skip": move to next phase (risky — later phases may depend on this one)
   - "Abort": go to Step 6 (Retrospective) with outcome "failed"

6. **If completed**: Append to progress log and continue

#### 3c. Between Phases

After each phase's implementer completes successfully:

1. Verify the commit exists:
   ```bash
   git log --oneline -1
   ```

2. Append to progress log:
   ```markdown
   #### Phase {N} — {timestamp}
   - Spec: {spec-file}
   - Commit: {hash}
   - Summary: {from AGENT_RESULT}
   ```

3. Continue to next phase

After all phases complete, update implementer status:
```bash
bash /Users/nicknisi/Developer/case/scripts/task-status.sh {task.json} agent implementer status completed
bash /Users/nicknisi/Developer/case/scripts/task-status.sh {task.json} agent implementer completed now
```

## Step 4: Full Validation

After all phases are implemented and committed, run the full test suite.

1. Read `projects.json` to find the repo's test command
2. Run full validation and pipe through mark-tested:
   ```bash
   {test command} 2>&1 | bash /Users/nicknisi/Developer/case/scripts/mark-tested.sh
   ```
3. Run remaining checks:
   ```bash
   {typecheck command}
   {lint command}
   {build command}
   ```
4. If any fail: attempt to fix, re-run. If unfixable, report to user.

## Step 5: Post-Implementation Pipeline

Run the standard case pipeline for verification, review, and PR creation. These agents cover the **combined diff** from all phases.

### 5a. Spawn Verifier

1. Update task status:
   ```bash
   bash /Users/nicknisi/Developer/case/scripts/task-status.sh {task.json} status verifying
   ```
2. Read `/Users/nicknisi/Developer/case/agents/verifier.md`
3. Use the `Agent` tool with verifier.md content + task context
4. Parse `AGENT_RESULT`
5. Handle failure: same as standard case pipeline (see case SKILL.md Step 5)

### 5b. Spawn Reviewer

1. Read `/Users/nicknisi/Developer/case/agents/reviewer.md`
2. Use the `Agent` tool with reviewer.md content + task context
3. Parse `AGENT_RESULT`
4. Handle failure: same as standard case pipeline (see case SKILL.md Step 6)

### 5c. Spawn Closer

1. Update task status:
   ```bash
   bash /Users/nicknisi/Developer/case/scripts/task-status.sh {task.json} status closing
   ```
2. Read `/Users/nicknisi/Developer/case/agents/closer.md`
3. Use the `Agent` tool with closer.md content + task context + verifier/reviewer results
4. Parse `AGENT_RESULT`
5. Handle failure: same as standard case pipeline (see case SKILL.md Step 7)

**PR title**: Use conventional commit format covering the contract scope:
```
feat(scope): {project-name} — {brief summary}
```

**PR description**: Should reference the ideation contract, list all phases implemented, and include verification evidence.

## Step 6: Complete

Report to user:
- PR URL from closer's `AGENT_RESULT`
- Summary: phases implemented, what was tested, what was reviewed

## Step 7: Retrospective

Same as standard case pipeline — spawn retrospective in background:

1. Read `/Users/nicknisi/Developer/case/agents/retrospective.md`
2. Spawn with `run_in_background: true`
3. Include: task file path, task JSON, pipeline outcome, all agent results

## Re-entry Semantics

If `/case:from-ideation` is invoked and a task already exists for this project:

1. Scan `/Users/nicknisi/Developer/case/tasks/active/*.task.json` for `issueType: "ideation"` matching the project name
2. If found, read the task's progress log to determine which phases completed
3. Resume from the next unimplemented phase:
   - **Some phases done**: Checkout the existing branch, skip completed phases, continue phase loop
   - **All phases done, pipeline incomplete**: Resume at the post-implementation pipeline step (verifier/reviewer/closer based on task status)
   - **PR already opened**: Report "PR already exists" and done

## Rules

Same rules as the main `/case` skill:
- **Always use `AskUserQuestion`** when asking questions
- **Always work in feature branches** — never commit to main
- **Always use conventional commits** — `type(scope): description`
- **Always open PRs** via `gh pr create`
- **PR descriptions must be thorough** — summary, phases, testing, contract reference

## Always Load

Read these first:
- `../../AGENTS.md` — project landscape and navigation
- `../../docs/golden-principles.md` — invariants across all repos
