# Task File Format

Tasks are markdown files that define work for agents. Drop a file in `tasks/active/`, and an agent executes it.

## Naming Convention

- **Single-repo**: `{repo}-{n}-{slug}.md`
  - `cli-1-add-widgets-command.md`
  - `authkit-nextjs-2-fix-session-refresh.md`
- **Cross-repo**: `x-{n}-{slug}.md`
  - `x-1-update-readme-badges.md`
  - `x-3-add-changelog-entry.md`

Numbers are sequential per prefix: `cli-1`, `cli-2`, `authkit-nextjs-1`, `x-1`, etc.

## Required Sections

| Section | Purpose |
| --- | --- |
| Mission Summary | Blockquote at the very top (before `# Title`) with Mission, Repo, and Done-when — survives context compaction |
| `# Title` | Brief description (becomes the task file name slug) |
| `## Objective` | What needs to happen and why |
| `## Target Repos` | Which repos this task touches (paths from projects.json) |
| `## Playbook` | Reference to the relevant playbook in docs/playbooks/ (if one exists) |
| `## Acceptance Criteria` | Checkboxes defining "done" — agent cannot mark done until these pass |
| `## Checklist` | Step-by-step progress tracker — agent checks items off as it works |

Optional: `## Context` for background info, issue links, API specs, etc.

## Lifecycle

1. Orchestrator creates task file (`.md` + `.task.json`) in `tasks/active/`
2. Implementer writes the fix/feature, runs tests, commits
3. Verifier tests the specific scenario with fresh context
4. Reviewer checks the diff against golden principles and conventions
5. Closer agent opens a PR in the target repo (requires `.case-reviewed` with critical: 0)
6. Post-PR hook updates `.task.json` status to `pr-opened`
7. After PR merge, status updated to `merged` (manual or automation)

Legacy tasks without a `.task.json` companion still use the old file-move behavior (`active/` → `done/`).

## JSON Companion File

Every new task has a `.task.json` companion alongside the `.md` file. Same filename stem:

```
tasks/active/authkit-nextjs-1-issue-53.md         # human-readable
tasks/active/authkit-nextjs-1-issue-53.task.json   # machine-touched
```

The JSON file stores structured metadata that agents and scripts update programmatically. Schema: `tasks/task.schema.json`.

Fields: `id`, `status`, `created`, `repo`, `issue`, `issueType`, `branch`, `agents`, `tested`, `manualTested`, `prUrl`, `prNumber`.

Read/write via: `bash ${CASE_REPO}/scripts/task-status.sh <file> <field> [value]`

**Evidence flags** (`tested`, `manualTested`) can only be set by marker scripts (`mark-tested.sh`, `mark-manual-tested.sh`) — not by agents directly.

### Evidence Markers

| Marker | Created by | Purpose |
| --- | --- | --- |
| `.case-tested` | `scripts/mark-tested.sh` | Proves automated tests ran (hash of test output) |
| `.case-manual-tested` | `scripts/mark-manual-tested.sh` | Proves manual/browser testing was performed |
| `.case-reviewed` | `scripts/mark-reviewed.sh` | Proves code review passed (critical: 0) |

#### `.case-tested` structured format

When piped JSON output from `vitest --reporter=json`, the marker contains structured fields parsed by `scripts/parse-test-output.sh`:

```
timestamp: ...
output_hash: ...
pass_indicators: N
fail_indicators: N
passed: N
failed: N
total: N
duration_ms: N
suites: N
files: [...]
```

Plain-text fallback uses grep heuristics for pass/fail indicators only.

## Status Lifecycle

```
active → implementing → verifying → reviewing → closing → pr-opened → merged

Recovery transitions:
  implementing → active       (restart after failure)
  verifying    → implementing (fix-and-retry)
  reviewing    → verifying    (critical findings, re-verify after fix)
  closing      → verifying    (hook failure, re-verify)
  pr-opened    → pr-opened    (idempotent, hook re-fire)
```

Pipeline agents: implementer → verifier → reviewer → closer → (retrospective)

Transitions are enforced by `task-status.sh`. Invalid transitions are rejected with an error.

## Progress Log

Every task file has a `## Progress Log` section at the end. Agents append entries — never edit existing ones. Each entry includes the agent name, timestamp, and what was done.

```markdown
## Progress Log

### Orchestrator — 2026-03-08T10:30:00Z
- Created task from GitHub issue #53
- Baseline smoke test: PASS

### Implementer — 2026-03-08T10:35:00Z
- Root cause: hardcoded cookie name
- Fix: use WORKOS_COOKIE_NAME env var
- Tests: 4 passing, committed abc123
```

## Example

```markdown
> **Mission**: Add `orgs list` CLI command so users can list organizations from the terminal
> **Repo**: ../cli/main
> **Done when**: `workos orgs list` outputs organizations in human-readable and JSON formats

# Add `workos orgs list` command

## Objective
Add an `orgs list` subcommand to the CLI that lists organizations
in the current WorkOS environment.

## Target Repos
- ../cli/main

## Playbook
docs/playbooks/add-cli-command.md

## Context
API endpoint: GET /organizations
See: https://workos.com/docs/reference/organization/list

## Acceptance Criteria
- [ ] `workos orgs list` outputs organizations in human-readable format
- [ ] `workos orgs list --json` outputs valid JSON
- [ ] Tests pass
- [ ] Types check

## Checklist
- [ ] Read playbook and CLI architecture doc
- [ ] Create src/commands/organization.ts
- [ ] Create src/commands/organization.spec.ts
- [ ] Register in src/bin.ts
- [ ] Update src/utils/help-json.ts
- [ ] Run pnpm test && pnpm typecheck
- [ ] Open PR with conventional commit message

## Progress Log

<!-- Agents append entries below. Do not edit existing entries. -->
```
