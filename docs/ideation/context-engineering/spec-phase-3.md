# Implementation Spec: Context Engineering - Phase 3 (Knowledge Accumulation)

**Contract**: ./contract.md
**Estimated Effort**: S

## Technical Approach

Phase 3 creates the knowledge accumulation loop. Two changes:

1. **Per-repo learnings files** — create `docs/learnings/{repo}.md` for each repo in `projects.json`. These start empty and are populated by the retrospective agent after each pipeline run.

2. **Retrospective agent updates** — extend the retrospective agent's prompt with two new responsibilities:
   - **Maintain learnings files**: After analyzing a run, append tactical knowledge to the relevant repo's learnings file
   - **Escalate repeated violations**: When the same type of failure appears in the learnings file multiple times, strengthen the relevant convention doc

This creates a compounding loop: each run deposits knowledge → future agents in that repo benefit → fewer failures → better PRs.

## Feedback Strategy

**Inner-loop command**: `grep -c "learnings" agents/retrospective.md`

**Playground**: None — markdown changes only. Validate by reading.

**Why this approach**: All changes are markdown. The retrospective agent already runs as part of the /case pipeline, so these changes take effect on the next run.

## File Changes

### New Files

| File Path | Purpose |
|-----------|---------|
| `docs/learnings/README.md` | Explains the learnings system |
| `docs/learnings/cli.md` | Tactical knowledge for cli repo (starts empty) |
| `docs/learnings/skills.md` | Tactical knowledge for skills repo (starts empty) |
| `docs/learnings/authkit-session.md` | Tactical knowledge for authkit-session repo (starts empty) |
| `docs/learnings/authkit-tanstack-start.md` | Tactical knowledge for authkit-tanstack-start repo (starts empty) |
| `docs/learnings/authkit-nextjs.md` | Tactical knowledge for authkit-nextjs repo (starts empty) |

### Modified Files

| File Path | Changes |
|-----------|---------|
| `agents/retrospective.md` | Add learnings maintenance and violation escalation responsibilities |
| `agents/implementer.md` | Add instruction to read learnings file during setup |
| `AGENTS.md` | Add learnings directory to navigation table |

## Implementation Details

### Learnings Directory and Files

**Overview**: Create `docs/learnings/` with a README and one file per repo. The repo files start empty (per contract decision) and accumulate knowledge through the retrospective agent.

**README content**:
```markdown
# Repo Learnings

Tactical knowledge accumulated by the retrospective agent across pipeline runs. Each file corresponds to a repo in `projects.json`.

## How it works

1. After every `/case` pipeline run, the retrospective agent analyzes what happened
2. If it discovers tactical knowledge specific to a repo, it appends to that repo's learnings file
3. The implementer agent reads the relevant learnings file during setup, before writing code
4. If the same issue appears 3+ times in a learnings file, the retrospective escalates it to a convention or golden principle

## Format

Each entry is a dated bullet point with context:

```markdown
- **2026-03-08** — `src/middleware.ts`: Mock `next/headers` as a module, not individual exports. Individual mocks cause type errors in strict mode. (from task authkit-nextjs-1-issue-53)
```

## Rules

- Agents append entries — never edit or remove existing ones
- Entries must reference the source task
- Keep entries to 1-2 lines — tactical, not narrative
- If an entry is later proven wrong, append a correction entry rather than deleting
```

**Per-repo file format** (all start identical):
```markdown
# {Repo Name} Learnings

Tactical knowledge from completed tasks. Read by agents before working in this repo.

<!-- Retrospective agent appends entries below. Do not edit existing entries. -->
```

**Implementation steps**:
1. Create `docs/learnings/README.md`
2. Create one file per repo from `projects.json`: cli, skills, authkit-session, authkit-tanstack-start, authkit-nextjs
3. Each file uses the template above with the repo name filled in

### Retrospective Agent — Learnings Maintenance

**Pattern to follow**: existing "### 4. Apply Improvements" section in `agents/retrospective.md`

**Overview**: Add a new step between "### 4. Apply Improvements" and "### 5. Output" that handles learnings file maintenance.

**What to add**:

```markdown
### 4b. Update Repo Learnings

After applying harness improvements, check if the run produced tactical knowledge specific to the target repo.

**What qualifies as a learning:**
- A gotcha the implementer hit that isn't in any existing doc (e.g., "mock X as module, not individual exports")
- A file path or pattern that was hard to find (e.g., "cookie config lives in `src/config/auth.ts`, not `src/middleware.ts`")
- An environment or setup quirk (e.g., "tests require `NODE_OPTIONS=--experimental-vm-modules`")
- A dependency behavior that surprised the agent (e.g., "`iron-webcrypto` seals differ from `iron-session` — can't decrypt across libraries")

**What does NOT qualify:**
- General programming knowledge
- Information already in the repo's CLAUDE.md or architecture docs
- One-time issues that won't recur

**How to append:**
1. Identify the target repo from the task file's `## Target Repos` section
2. Read `docs/learnings/{repo}.md`
3. Check if a similar learning already exists (don't duplicate)
4. Append a new entry:
   ```
   - **{YYYY-MM-DD}** — `{file or area}`: {1-2 line tactical note}. (from task {task-filename})
   ```

### 4c. Escalate Repeated Violations

After updating learnings, scan the learnings file for patterns:

1. Read `docs/learnings/{repo}.md`
2. Look for 3+ entries describing the same class of issue (e.g., multiple entries about mocking, multiple about import paths)
3. If found, escalate:
   - If it's a repo-specific pattern → note it for the repo's CLAUDE.md (add a comment to the learnings file: "ESCALATION CANDIDATE: consider adding to {repo} CLAUDE.md")
   - If it's a cross-repo pattern → add to `docs/golden-principles.md` or the relevant convention doc
4. Log the escalation in your output summary
```

**Key decisions**:
- Append-only format preserves history and prevents agents from "cleaning up" useful entries
- Correction entries (rather than deletions) maintain an audit trail
- Escalation at 3+ occurrences balances signal vs noise — one occurrence could be a fluke, three is a pattern
- Learnings file is read by the implementer, closing the feedback loop

**Implementation steps**:
1. Read `agents/retrospective.md`
2. Insert sections 4b and 4c between existing sections 4 and 5
3. Update the "What you can edit" list to include `docs/learnings/`
4. Update the output format to include learnings entries in the summary

### Implementer Agent — Read Learnings

**Pattern to follow**: existing "### 1. Setup" section in `agents/implementer.md`

**Overview**: Add one line to the implementer's setup step: read the relevant repo's learnings file before starting implementation.

**Note**: The implementer now has a "### 0. Session Context" section and 5 setup steps (from the harness-improvements project). The current setup steps are:
1. Update task JSON
2. Read the task file
3. Read the target repo's CLAUDE.md
4. Read the playbook
5. Read projects.json for available commands

**What to add** (after step 5 "Read projects.json"):

```markdown
6. Read `${CASE_REPO}/docs/learnings/{repo}.md` for tactical knowledge from previous tasks in this repo
```

**Implementation steps**:
1. Read `agents/implementer.md`
2. Add learnings file read as step 6 in the Setup section

### AGENTS.md Update

**Overview**: Add learnings directory to the Navigation table.

**Implementation steps**:
1. Read `AGENTS.md`
2. Add row: `| Repo learnings | docs/learnings/ |`

## Validation Commands

```bash
# Verify learnings directory structure
ls docs/learnings/ | wc -l  # should be 6 (README + 5 repos)

# Verify all repo files exist
for repo in cli skills authkit-session authkit-tanstack-start authkit-nextjs; do
  test -f "docs/learnings/${repo}.md" && echo "OK: ${repo}" || echo "MISSING: ${repo}"
done

# Verify retrospective has learnings section
grep "Repo Learnings" agents/retrospective.md

# Verify implementer reads learnings
grep "learnings" agents/implementer.md

# Verify AGENTS.md references learnings
grep "learnings" AGENTS.md
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
