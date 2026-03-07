# Context Map: case-harness

**Phase**: 1
**Scout Confidence**: 85/100
**Verdict**: GO

## Dimensions

| Dimension | Score | Notes |
|---|---|---|
| Scope clarity | 19/20 | 10 new files, all with explicit content templates in spec. Greenfield repo. |
| Pattern familiarity | 16/20 | No existing patterns in empty repo. Spec provides content templates. Skills plugin.json read for Phase 6 reference. |
| Dependency awareness | 18/20 | All files new, no consumers. 5 sibling repos confirmed accessible, metadata extracted. |
| Edge case coverage | 15/20 | Relative path resolution, AGENTS.md line count, JSON schema validity, per-repo command differences identified. |
| Test strategy | 17/20 | 4 validation commands in spec are copy-paste ready. No automated test framework needed. |

## Sibling Repo Metadata

### cli (`../cli/main`)
- **Description**: WorkOS CLI for installing AuthKit integrations and managing WorkOS resources
- **Language**: TypeScript | **PM**: pnpm
- **Remote**: https://github.com/workos/cli
- **Commands**: setup=`pnpm install`, build=`pnpm build`, test=`pnpm test`, lint=`pnpm lint` (oxlint), typecheck=`pnpm typecheck`

### skills (`../skills`)
- **Description**: Claude Code plugin providing WorkOS integration skills
- **Language**: TypeScript (tsx, no build) | **PM**: pnpm
- **Remote**: https://github.com/workos/skills
- **Commands**: setup=`pnpm install`, test=`pnpm test` (vitest), lint=`pnpm lint` (oxlint), format=`pnpm format` (oxfmt)
- **Note**: No build or typecheck scripts

### authkit-session (`../authkit-session`)
- **Description**: Framework-agnostic TypeScript authentication library for WorkOS with pluggable storage adapters
- **Language**: TypeScript | **PM**: pnpm
- **Remote**: https://github.com/workos/authkit-session.git
- **Commands**: setup=`pnpm install`, build=`pnpm run build`, test=`pnpm test`, typecheck=`pnpm run typecheck`, format=`pnpm run format` (prettier)
- **Note**: No lint script; uses prettier for checks

### authkit-tanstack-start (`../authkit-tanstack-start`)
- **Description**: WorkOS library for TanStack React Start providing authentication and session management helpers
- **Language**: TypeScript | **PM**: pnpm
- **Remote**: https://github.com/workos/authkit-tanstack-start.git
- **Commands**: setup=`pnpm install`, build=`pnpm build`, test=`vitest run`, typecheck=`pnpm run typecheck`, format=`pnpm run format` (prettier)
- **Note**: No lint script; uses prettier for checks

### authkit-nextjs (`../authkit-nextjs`)
- **Description**: Authentication and session helpers for using WorkOS & AuthKit with Next.js
- **Language**: TypeScript | **PM**: pnpm
- **Remote**: https://github.com/workos/authkit-nextjs.git
- **Commands**: setup=`pnpm install`, build=`pnpm run build`, test=`pnpm test`, lint=`pnpm run lint` (eslint), typecheck=`pnpm run typecheck`

## Risks

- **Command fields vary**: Some repos lack lint/build/typecheck. Schema must allow optional command fields.
- **Relative path sensitivity**: projects.json paths resolve from case/ root via `path.resolve()`.
- **AGENTS.md 100-line budget**: Tight — count lines during writing.
- **Forward references**: AGENTS.md will reference docs/ paths that don't exist until Phase 3 (intentional).
