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
| `# Title` | Brief description (becomes the task file name slug) |
| `## Objective` | What needs to happen and why |
| `## Target Repos` | Which repos this task touches (paths from projects.json) |
| `## Playbook` | Reference to the relevant playbook in docs/playbooks/ (if one exists) |
| `## Acceptance Criteria` | Checkboxes defining "done" — agent cannot mark done until these pass |
| `## Checklist` | Step-by-step progress tracker — agent checks items off as it works |

Optional: `## Context` for background info, issue links, API specs, etc.

## Lifecycle

1. Human (or agent) creates task file in `tasks/active/`
2. Agent reads the task, follows the checklist, does the work
3. Agent opens a PR in the target repo
4. After PR merge, task file moves to `tasks/done/`

## Example

```markdown
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
```
