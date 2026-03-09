# Playbook: Fix a Bug

> Applies to any repo in `projects.json`
> Reference: [docs/conventions/testing.md](../conventions/testing.md), [docs/conventions/pull-requests.md](../conventions/pull-requests.md)

## Step 1: Understand the Bug

Read the issue/report. Identify:

- **Expected behavior**: What should happen?
- **Actual behavior**: What happens instead?
- **Reproduction steps**: How to trigger the bug.
- **Affected repo**: Which repo owns this code? Check `projects.json` for the list.

If the report is vague, search for related issues or error messages in the codebase before proceeding.

## Step 2: Set Up the Target Repo

```bash
cd {repo-path}           # e.g., ../cli/main or ../authkit-session
```

Read the repo's `AGENTS.md` for setup instructions. At minimum:

```bash
pnpm install
pnpm test                # confirm tests pass on main before you start
```

If the repo has a build step (`pnpm build`), run it to confirm the baseline is clean.

## Step 3: Reproduce the Bug

Write a failing test first if possible. This is the strongest form of reproduction.

```bash
# Create or modify {file}.spec.ts to demonstrate the bug
pnpm test -- --reporter=verbose {path-to-spec}
```

If a test isn't feasible (e.g., environment-specific bug), document the reproduction steps in the PR description.

### Where to Look by Repo

| Repo | Common bug locations |
|------|---------------------|
| `cli` | `src/commands/*.ts` (command logic), `src/lib/*.ts` (core), `src/utils/*.ts` (output/formatting) |
| `authkit-session` | `src/core/AuthKitCore.ts` (JWT/refresh), `src/core/session/CookieSessionStorage.ts`, `src/service/AuthService.ts` |
| `authkit-nextjs` | `src/middleware.ts`, `src/session.ts`, `src/auth.ts`, `src/authkit-callback-route.ts` |
| `authkit-tanstack-start` | `src/server/middleware.ts`, `src/server/storage.ts`, `src/server/server-functions.ts`, `src/client/AuthKitProvider.tsx` |
| `skills` | `plugins/workos/skills/*/SKILL.md`, `scripts/eval/scorer.ts` |

## Step 4: Identify Root Cause

Trace from the failing test (or reproduction) back to the source:

1. Find the function producing the wrong output.
2. Check recent commits to see if this is a regression (`git log --oneline -20 -- {file}`).
3. Check if the bug exists in related repos (e.g., a session bug might affect both `authkit-nextjs` and `authkit-tanstack-start` if it originates in `authkit-session`).

## Step 5: Implement the Fix

- Fix the root cause, not the symptom.
- Keep the change minimal -- one concern per commit.
- If the fix requires a refactor, do the refactor in a separate commit first.

## Step 6: Verify the Fix

```bash
pnpm test                # all tests pass, including your new one
pnpm build               # build succeeds (includes type checking via tsc)
pnpm typecheck           # if available as a separate command (check projects.json)
pnpm lint                # where applicable (cli, authkit-nextjs, skills)
pnpm format              # formatter passes
```

Confirm no regressions by running the full test suite, not just your new test.

## Step 7: Code Review

Before opening a PR, the reviewer agent checks the diff against golden principles and conventions:

- All enforced invariants (TypeScript strict, tests pass, conventional commits, no secrets, etc.)
- Advisory checks (file size, test coverage, one concern per PR)
- Structured test output from `.case-tested` (fail count must be 0)

Critical findings block PR creation. Warnings and info are posted as PR comments.

Evidence: `.case-reviewed` marker (created by `scripts/mark-reviewed.sh` only if critical: 0).

## Step 8: Open PR

- Branch: `fix/{brief-slug}`
- Commit: `fix: {description}` (conventional commit)
- If there's a GitHub issue, reference it: `fix: resolve session refresh race condition (fixes #123)`
- PR description: explain what was broken, why, and how the fix works.
- Follow [PR conventions](../conventions/pull-requests.md).

## Cross-Repo Bug Patterns

Some bugs span repos. Common patterns:

| Pattern | Example | Action |
|---------|---------|--------|
| Session logic bug | Token refresh fails in all frameworks | Fix in `authkit-session`, verify in framework repos |
| SDK type mismatch | CLI breaks after `@workos-inc/node` update | Fix in `cli`, check if other repos import the same type |
| Skill produces wrong output | Agent generates bad code from skill | Fix the SKILL.md or topic file, re-run eval |

If the bug originates in a shared dependency (`authkit-session`), you may need to open PRs in multiple repos. Use the [cross-repo update playbook](cross-repo-update.md) for coordination.

## Verification Checklist

- [ ] Bug is reproducible (test or documented steps)
- [ ] Root cause identified and documented in PR
- [ ] Fix addresses root cause, not symptom
- [ ] New test prevents recurrence
- [ ] All existing tests still pass
- [ ] TypeScript strict mode, no errors
- [ ] Formatter passes
- [ ] Build succeeds (where applicable)
- [ ] Commit message follows conventional commits (`fix: ...`)

## Common Mistakes

- **Fixing the symptom**. If a function returns wrong data, don't patch the caller -- fix the function.
- **Skipping the test**. Every bug fix should add a test that would have caught the bug.
- **Not checking related repos**. Session bugs often exist in multiple AuthKit packages.
- **Bundling refactors with fixes**. Keep the fix commit separate from any cleanup.
