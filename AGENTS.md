# Case — WorkOS OSS Harness

Spine repo for orchestrating agent work across WorkOS open source projects.
Humans steer. Agents execute. When agents struggle, fix the harness.

## Projects

| Repo | Path | Purpose | Stack |
| --- | --- | --- | --- |
| cli | `../cli/main` | WorkOS CLI — AuthKit installers, resource management | TS/pnpm |
| skills | `../skills` | Claude Code plugin — WorkOS integration skills | TS/pnpm |
| authkit-session | `../authkit-session` | Framework-agnostic session management | TS/pnpm |
| authkit-tanstack-start | `../authkit-tanstack-start` | AuthKit TanStack Start SDK | TS/pnpm |
| authkit-nextjs | `../authkit-nextjs` | AuthKit Next.js SDK | TS/pnpm |

Full metadata (commands, remotes, language): `projects.json`

## Navigation

| Topic | Location |
| --- | --- |
| Architecture patterns | `docs/architecture/` |
| Shared conventions | `docs/conventions/` |
| Golden principles | `docs/golden-principles.md` |
| Playbooks | `docs/playbooks/` |

## Task Dispatch

Tasks are markdown files that agents execute. Drop a file in `tasks/active/`, an agent picks it up.

- **Single-repo**: `{repo}-{n}-{slug}.md` (e.g., `cli-1-add-widgets-command.md`)
- **Cross-repo**: `x-{n}-{slug}.md` (e.g., `x-1-update-readme-badges.md`)
- **Templates**: `tasks/templates/`
- **Format spec**: `tasks/README.md`

Lifecycle: `tasks/active/` → `tasks/done/` (moved after PR merge)

## Working in a Target Repo

1. Read the repo's `AGENTS.md` for project-specific instructions
2. Run `scripts/bootstrap.sh {repo-name}` to verify readiness
3. Follow the repo's PR checklist before opening a PR
4. Run `scripts/check.sh --repo {repo-name}` to verify conventions

## Improving This Harness

See `CLAUDE.md` for how to maintain and improve case itself.
