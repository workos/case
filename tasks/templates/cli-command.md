# Add CLI Command: {command-name}

## Objective

Add `workos {command-name}` command to the CLI for managing {resource-description}.

## Target Repos

- ../cli/main

## Playbook

docs/playbooks/add-cli-command.md

## Context

{Describe what this command does, what API endpoint(s) it calls, expected input/output. Link to WorkOS API docs if available.}

API endpoint: {e.g., GET /resources, POST /resources, GET /resources/:id}

## Acceptance Criteria

- [ ] Command registered and appears in `workos --help`
- [ ] Subcommands implemented: {list, get, create, update, delete -- specify which}
- [ ] Human-readable output works for all subcommands
- [ ] JSON output mode works (`--json` flag)
- [ ] `workos --help --json` includes the new command in the command tree
- [ ] Tests pass (`pnpm test`)
- [ ] Types check (`pnpm typecheck`)
- [ ] Lint passes (`pnpm lint`)
- [ ] Build succeeds (`pnpm build`)

## Checklist

- [ ] Read playbook (`docs/playbooks/add-cli-command.md`) and architecture doc (`docs/architecture/cli.md`)
- [ ] Create `src/commands/{command-name}.ts` following `organization.ts` pattern
- [ ] Create `src/commands/{command-name}.spec.ts` with JSON mode tests
- [ ] Register command in `src/bin.ts` via yargs + `registerSubcommand()`
- [ ] Add command to `src/utils/help-json.ts` registry
- [ ] Run `pnpm test && pnpm typecheck && pnpm lint && pnpm format && pnpm build`
- [ ] Open PR with conventional commit: `feat: add {command-name} command`

## Progress Log

<!-- Agents append entries below. Do not edit existing entries. -->
