# Implementation Spec: Case Multi-Agent - Phase 2

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 2 creates the three agent prompt files that the orchestrator will spawn as subagents: implementer, verifier, and closer. Each follows the pattern established by the ideation plugin's `reviewer.md` and `scout.md` — a frontmatter block declaring name, description, and tools, followed by structured sections for input, workflow, rules, and output format.

The key design principle: each agent has a **focused context window**. The implementer never thinks about Playwright. The verifier never thinks about implementation strategy. The closer never thinks about code. This separation is what prevents the context pollution that causes the single-agent `/case` to forget checklist items.

Each agent reads and writes to the task file (Markdown progress log + JSON companion), creating a shared communication channel between phases.

Additionally, every agent must end its response with a structured `AGENT_RESULT` JSON block so the orchestrator can parse results deterministically instead of relying on narrative text.

## File Changes

### New Files

| File Path | Purpose |
|-----------|---------|
| `agents/implementer.md` | Subagent prompt: code changes + unit tests in target repo |
| `agents/verifier.md` | Subagent prompt: manual testing, Playwright, evidence markers, screenshots |
| `agents/closer.md` | Subagent prompt: PR creation with proper description, hook satisfaction |

## Implementation Details

### Implementer Agent

**Pattern to follow**: Ideation plugin's `agents/reviewer.md` and `agents/scout.md` (in the ideation plugin's `agents/` directory)

**Overview**: The implementer receives a task file path, target repo path, and issue details. It implements the fix, runs unit tests, commits with a conventional message, and updates the task progress log. It does NOT do manual testing, create evidence markers, or create PRs.

```markdown
---
name: implementer
description: Focused code implementation agent for /case. Writes fixes, runs unit tests, commits. Does not handle manual testing, evidence, or PRs.
tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"]
---
```

**Key decisions**:

- Implementer reads the target repo's CLAUDE.md for project-specific instructions
- Implementer reads the relevant playbook (from task file's `## Playbook` section)
- Implementer commits with conventional commit format (`fix(scope): description`)
- Implementer updates the task progress log with what it did: files changed, test results, commit hash
- Implementer updates task JSON: status → `implementing`, agent phase → started/completed (via `task-status.sh`)
- Implementer pipes test output through `mark-tested.sh` to create evidence. The marker script also sets `tested: true` in task JSON — the implementer does NOT set this field directly
- Implementer does NOT start example apps, run Playwright, create screenshots, or create PRs

**Workflow sections to include**:

1. **Input** — What the orchestrator passes: task file path (.md + .task.json), target repo path, issue summary, playbook path
2. **Setup** — Read task file, read repo CLAUDE.md, read playbook, understand the issue
3. **Implement** — Follow the playbook steps: reproduce bug (write failing test), identify root cause, implement fix, verify fix (test passes)
4. **Validate** — Run full automated checks: `test`, `typecheck`, `lint`, `build` (whatever the repo has in projects.json)
5. **Record** — Pipe test output through `mark-tested.sh`. Commit with conventional message. Append to progress log. Update task JSON status.
6. **Output** — End response with AGENT_RESULT block using exact delimiters:
   ```
   <<<AGENT_RESULT
   {"status":"completed","summary":"...","artifacts":{"commit":"abc123","filesChanged":["src/x.ts"],"testsPassed":true,"screenshotUrls":[],"evidenceMarkers":[],"prUrl":null,"prNumber":null},"error":null}
   AGENT_RESULT>>>
   ```
7. **Rules** — Never start example apps. Never run Playwright. Never create PRs. Never push. Always commit before returning. Always update progress log. Always end with AGENT_RESULT delimiters.

**Implementation steps**:

1. Read the ideation reviewer.md and scout.md to understand the agent prompt structure
2. Create `agents/implementer.md` with frontmatter and all workflow sections
3. Include explicit references to `mark-tested.sh` path and `task-status.sh` path
4. Include the conventional commit format rules from `docs/conventions/commits.md`
5. Include instruction to read `projects.json` to find the repo's commands (test, typecheck, etc.)

### Verifier Agent

**Pattern to follow**: Ideation plugin's `agents/reviewer.md`

**Overview**: The verifier starts with a completely fresh context. It reads the git diff to understand what changed, then tests the **specific fix** — not just the happy path. It uses Playwright for front-end testing, creates evidence markers, captures and uploads screenshots. This agent exists because the implementer's context is polluted with implementation details and can't objectively verify its own work.

```markdown
---
name: verifier
description: Fresh-context verification agent for /case. Reads the diff, tests the specific fix with Playwright, creates evidence markers and screenshots. Never implements.
tools: ["Read", "Bash", "Glob", "Grep"]
---
```

**Key decisions**:

- Verifier reads the diff first, not the implementation — it should understand *what changed* before testing
- Verifier loads the `playwright-cli` skill for browser testing
- Verifier reads test credentials from `~/.config/case/credentials` (never logs them)
- Verifier must test the **specific fix scenario**, not just sign-in/sign-out. It reads the issue details from the task file to understand what to reproduce.
- Verifier creates `.case-manual-tested` via `mark-manual-tested.sh` (not `touch`)
- Verifier uploads screenshots via `upload-screenshot.sh` and saves the markdown image tags to the progress log
- Verifier skips manual testing if no `src/` files changed (same logic as pre-PR hook)
- Verifier updates task JSON: status → `verifying`, agent phase → started/completed (via `task-status.sh`). The `manualTested` flag is set by `mark-manual-tested.sh` as a side effect — the verifier does NOT set it directly

**Workflow sections to include**:

1. **Input** — Task file path, target repo path
2. **Assess** — Read task JSON status (should be `implementing` completed). Read git diff (`git diff HEAD~1` or `git log --oneline -5` to find the implementation commit). Read the task file's issue reference to understand what to test specifically.
3. **Determine scope** — Check if `src/` files changed. If not, skip manual testing, mark as verified, update status.
4. **Test the specific fix** — This is the critical section. Include explicit guidance:
   - Read the issue description from the task file
   - Identify the specific bug/feature scenario
   - Start the example app if one exists (check task file's target repo against projects.json)
   - Load `playwright-cli` skill
   - Navigate to the relevant page/flow
   - Reproduce the exact scenario from the issue
   - Verify the fix works (the specific behavior, not just "the app loads")
   - Ask yourself: "If I reverted the implementer's commit, would this test fail?" If no, you're testing the wrong thing.
5. **Capture evidence** — Take screenshots (before state may not be available, but capture current working state). Upload via `upload-screenshot.sh`. Run `mark-manual-tested.sh`.
6. **Record** — Append to progress log: what was tested, how, screenshots, pass/fail. Update task JSON.
7. **Output** — End response with AGENT_RESULT block using exact delimiters:
   ```
   <<<AGENT_RESULT
   {"status":"completed","summary":"...","artifacts":{"commit":null,"filesChanged":[],"testsPassed":null,"screenshotUrls":["![name](url)"],"evidenceMarkers":[".case-tested",".case-manual-tested"],"prUrl":null,"prNumber":null},"error":null}
   AGENT_RESULT>>>
   ```
8. **Rules** — Never edit source code. Never commit. Never create PRs. Always test the specific fix scenario. Always create evidence markers via scripts (never `touch`). Never log credentials. Always end with AGENT_RESULT delimiters.

**Implementation steps**:

1. Read reviewer.md structure
2. Create `agents/verifier.md` with frontmatter and all workflow sections
3. Include explicit `playwright-cli` usage examples (the correct syntax, no `--path` flag)
4. Include the "ask yourself: if I reverted..." test from SKILL.md
5. Include credential safety rules (read from file, use only in .env files, never in curl or logs)
6. Include `upload-screenshot.sh` path and usage
7. Include `mark-manual-tested.sh` path and usage

### Closer Agent

**Pattern to follow**: Ideation plugin's `agents/reviewer.md` (for structure, though closer has a different purpose)

**Overview**: The closer creates the PR. It reads the task file, verification evidence, and progress log to draft a thorough PR description. It must satisfy all pre-PR hook gates. It's the only agent that runs `gh pr create`.

```markdown
---
name: closer
description: PR creation agent for /case. Drafts thorough PR descriptions from task file and verification evidence. Satisfies pre-PR hook gates. Never implements or tests.
tools: ["Read", "Bash", "Glob", "Grep"]
---
```

**Key decisions**:

- Closer reads the entire progress log to understand what was done across all agents
- Closer reads verification evidence (screenshots, marker files) to include in PR description
- Closer reads the task file's issue reference to link the PR to the issue
- Closer uses the PR conventions from `docs/conventions/pull-requests.md`
- Closer uses conventional commit format for PR title
- PR description must include: summary, what was tested (from verifier log), verification screenshots (markdown from upload), issue link, any follow-ups
- Closer runs a pre-flight check before `gh pr create`: verify `.case-tested` and `.case-manual-tested` exist with evidence, verify not on main branch
- Closer updates task JSON: status → `pr-opened`, prUrl → PR URL

**Workflow sections to include**:

1. **Input** — Task file path, target repo path, verification summary (from verifier output)
2. **Gather context** — Read task file (full), read progress log entries from all agents, read verification evidence markers, read screenshot markdown from verifier's log
3. **Draft PR** — Following `docs/conventions/pull-requests.md`:
   - Title: conventional commit format (e.g., `fix(session): handle custom cookie name in org switching`)
   - Body: Summary, What was tested, Verification screenshots, Issue link, Follow-ups
4. **Pre-flight** — Check pre-PR requirements:
   - Verify branch is not main/master
   - Read `.case-tested` — must exist with `output_hash` (always required)
   - Check if `src/` files changed: `git diff --name-only main | grep "^src/"`
     - If src/ changed: `.case-manual-tested` must exist with `evidence` field
     - If no src/ changed: `.case-manual-tested` is not required (matches pre-PR hook logic)
   - If any required check fails, report what's missing and stop — do NOT attempt `gh pr create`.
5. **Create PR** — Run `gh pr create` with drafted title and body. Use heredoc format for body.
6. **Record** — Update task JSON: status → `pr-opened`, prUrl. Append to progress log. Clean up is handled by the post-PR hook.
7. **Output** — End response with AGENT_RESULT block using exact delimiters:
   ```
   <<<AGENT_RESULT
   {"status":"completed","summary":"...","artifacts":{"commit":null,"filesChanged":[],"testsPassed":null,"screenshotUrls":[],"evidenceMarkers":[],"prUrl":"https://github.com/...","prNumber":54},"error":null}
   AGENT_RESULT>>>
   ```
8. **Rules** — Never edit source code. Never run tests. Never use Playwright. Always pre-flight before PR creation. Always include verification notes in PR body. Always link the issue. Always end with AGENT_RESULT delimiters.

**Implementation steps**:

1. Read reviewer.md structure
2. Read `docs/conventions/pull-requests.md` for PR description requirements
3. Create `agents/closer.md` with frontmatter and all workflow sections
4. Include the heredoc format for `gh pr create --body`
5. Include pre-flight check logic (read marker files, check branch)
6. Include `task-status.sh` usage for updating status and PR URL

## Testing Requirements

### Manual Testing

- [ ] Read each agent prompt file and verify it has: frontmatter, input section, workflow steps, rules, output format
- [ ] Verify implementer prompt does NOT mention Playwright, screenshots, or PR creation
- [ ] Verify verifier prompt does NOT mention editing code or committing
- [ ] Verify closer prompt does NOT mention editing code, running tests, or using Playwright
- [ ] Verify all three reference correct absolute script paths (`${CASE_REPO}/scripts/mark-tested.sh`, etc.)
- [ ] Verify all three include the AGENT_RESULT output format section

## Validation Commands

```bash
# Verify all agent files exist
ls -la agents/implementer.md agents/verifier.md agents/closer.md

# Verify frontmatter is present in each
head -5 agents/implementer.md agents/verifier.md agents/closer.md

# Check no cross-contamination: implementer shouldn't mention playwright
grep -i "playwright" agents/implementer.md && echo "FAIL: implementer mentions playwright" || echo "OK"

# Check no cross-contamination: verifier shouldn't mention "Edit" or "Write" tool
grep -E "Edit|Write" agents/verifier.md | grep -v "never edit" | grep -v "read-only" && echo "FAIL: verifier has edit/write references" || echo "OK"

# Check no cross-contamination: closer shouldn't mention playwright
grep -i "playwright" agents/closer.md && echo "FAIL: closer mentions playwright" || echo "OK"

# Check all agents include AGENT_RESULT delimiters
grep "<<<AGENT_RESULT" agents/implementer.md && echo "OK: implementer has AGENT_RESULT" || echo "FAIL"
grep "<<<AGENT_RESULT" agents/verifier.md && echo "OK: verifier has AGENT_RESULT" || echo "FAIL"
grep "<<<AGENT_RESULT" agents/closer.md && echo "OK: closer has AGENT_RESULT" || echo "FAIL"
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
