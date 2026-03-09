# Case — WorkOS OSS Harness

Spine repo for orchestrating agent work across WorkOS open source projects.
Humans steer. Agents execute. When agents struggle, fix the harness.

## First Step

Run the session-start script to gather context before doing anything else:
```bash
SESSION=$(bash /Users/nicknisi/Developer/case/scripts/session-start.sh <target-repo-path> --task <task.json>)
echo "$SESSION"
```

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
| Agent roles | `agents/` |
| Entropy management | `docs/conventions/entropy-management.md` |

## Task Dispatch

Tasks are markdown files that agents execute. Drop a file in `tasks/active/`, an agent picks it up.

- **Format spec**: `tasks/README.md`
- **Templates**: `tasks/templates/`

Pipeline: implementer → verifier → reviewer → closer → (retrospective)

Lifecycle: `tasks/active/` → `tasks/done/` (moved after PR merge)

## Working in a Target Repo

0. Run `scripts/session-start.sh {repo-path}` to gather context
1. Read the repo's `CLAUDE.md` (or `CLAUDE.local.md`) for project-specific instructions
2. Run `scripts/bootstrap.sh {repo-name}` to verify readiness
3. Follow the repo's PR checklist before opening a PR
4. Run `scripts/check.sh --repo {repo-name}` to verify conventions

## Maintenance

- **Entropy scanning**: `scripts/entropy-scan.sh` — detect convention drift across repos
- **Convention checks**: `scripts/check.sh` — enforce shared rules

## Improving This Harness

See `CLAUDE.md` for how to maintain and improve case itself.
