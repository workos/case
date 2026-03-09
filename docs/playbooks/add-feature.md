# Playbook: Add a Feature

> Applies to any repo in `projects.json`
> Reference: [docs/conventions/testing.md](../conventions/testing.md), [docs/conventions/pull-requests.md](../conventions/pull-requests.md)

## Step 1: Understand the Feature

Read the issue/request. Identify:

- **What**: What new capability is being added?
- **Why**: What user problem does it solve?
- **API surface**: What new exports, functions, types, or options are introduced?
- **Backward compatibility**: Does this change any existing behavior?
- **Affected repo**: Which repo owns this code? Check `projects.json` for the list.

## Step 2: Set Up the Target Repo

```bash
cd {repo-path}
```

Read the repo's `CLAUDE.md` for setup instructions. At minimum:

```bash
pnpm install
pnpm test                # confirm tests pass on main before you start
pnpm build               # confirm build passes (where applicable)
```

## Step 3: Plan the Implementation

Before writing code, identify:

1. **Files to modify** — which source files need changes?
2. **New files** — any new source or test files needed?
3. **Export surface** — does `index.ts` need new exports?
4. **Type changes** — any new interfaces, types, or type modifications?
5. **Example updates** — do example apps need updating to demonstrate the feature?

Keep the change minimal. Don't bundle unrelated improvements.

## Step 4: Implement

- Add the new capability with proper TypeScript types
- Maintain backward compatibility — existing exports and behavior must not change
- Follow the repo's existing patterns (naming, file organization, export style)
- One concern per commit

## Step 5: Add Tests

Every new export or behavior needs test coverage:

- **Unit tests**: Test the new functions/exports directly
- **Integration tests**: If the feature interacts with existing code, test those paths
- **Type tests**: If new types are exported, verify they work as expected

```bash
pnpm test -- --reporter=verbose {path-to-spec}
```

## Step 6: Update Examples (if applicable)

If the repo has example apps and the feature adds a new API that the examples should use:

1. Update example code to demonstrate the new feature
2. Verify the example app still builds and runs correctly

## Step 7: Verify

Run all available checks from the repo's `projects.json` commands:

```bash
pnpm test                # all tests pass
pnpm build               # build succeeds (includes type checking)
pnpm lint                # where applicable
pnpm format              # formatter passes
```

If the repo has a separate `pnpm typecheck` command, run that too.

## Step 8: Code Review

Before opening a PR, the reviewer agent checks the diff against golden principles and conventions:

- All enforced invariants (TypeScript strict, tests pass, conventional commits, no secrets, etc.)
- Advisory checks (file size, test coverage, one concern per PR)
- Structured test output from `.case-tested` (fail count must be 0)

Critical findings block PR creation. Warnings and info are posted as PR comments.

Evidence: `.case-reviewed` marker (created by `scripts/mark-reviewed.sh` only if critical: 0).

## Step 9: Open PR

- Branch: `feat/{brief-slug}` or `feat/issue-{N}`
- Commit: `feat(scope): {description}` (conventional commit)
- If there's a GitHub issue, reference it: `feat(middleware): add proxy alias (closes #364)`
- PR description: explain what was added, why, and how it works.
- Follow [PR conventions](../conventions/pull-requests.md).

## Verification Checklist

- [ ] New capability works as described in the issue
- [ ] Existing behavior unchanged (backward compatible)
- [ ] New exports have test coverage
- [ ] All existing tests still pass
- [ ] TypeScript strict mode, no errors
- [ ] Formatter passes
- [ ] Build succeeds (where applicable)
- [ ] Examples updated (if applicable)
- [ ] Commit message follows conventional commits (`feat: ...`)

## Common Mistakes

- **Breaking backward compatibility**. Existing imports and behavior must still work unless the issue explicitly calls for a breaking change.
- **Skipping example updates**. If there's an example app that could use the new feature, update it — it serves as living documentation.
- **Over-scoping**. Add what was requested, not what you think would be nice to have.
- **Wrong commit type**. New features use `feat:`, not `fix:` or `chore:`.
