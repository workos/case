# Playbook: Cross-Repo Update

> For coordinated changes across multiple WorkOS OSS repos.
> Repo list: `projects.json` at the case repo root.

## When to Use

- Updating a shared convention across all repos (e.g., badge format, CI config).
- Bumping a dependency version in multiple repos.
- Propagating a breaking change from `authkit-session` to framework packages.
- Adding a new standard file to all repos (e.g., AGENTS.md update).

## Step 1: Define the Change

Before touching any repo, write down:

1. **What** changes in each repo (be specific -- file paths, content).
2. **Why** this needs to be coordinated (vs independent changes).
3. **Which repos** are affected. Check `projects.json`:

| Name | Path |
|------|------|
| cli | `../cli/main` |
| skills | `../skills` |
| authkit-session | `../authkit-session` |
| authkit-tanstack-start | `../authkit-tanstack-start` |
| authkit-nextjs | `../authkit-nextjs` |

4. **Dependency order** -- if repos depend on each other, changes must merge in order. Typical order:
   ```
   authkit-session --> authkit-nextjs, authkit-tanstack-start --> cli
   ```

## Step 2: Decide Task Strategy

**Single cross-repo task** (`x-{n}-{slug}.md`): Use when the change is mechanical and identical across repos (e.g., update a badge, add a file).

**Multiple per-repo tasks** (`{repo}-{n}-{slug}.md`): Use when each repo requires different logic or when changes must merge in sequence.

For dependency-ordered changes, always use multiple per-repo tasks so each PR can be reviewed and merged independently.

## Step 3: Read Each Repo's AGENTS.md

Before modifying a repo, read its `AGENTS.md` for:

- Setup commands (`pnpm install`)
- Check commands (test, typecheck, lint, format, build)
- Architecture notes specific to that repo

## Step 4: Make Changes Per Repo

For each affected repo:

1. **Create a branch**: `chore/{slug}` or `feat/{slug}` depending on change type.
2. **Make the change**.
3. **Run all checks**:

| Repo | Checks |
|------|--------|
| cli | `pnpm test && pnpm typecheck && pnpm lint && pnpm format && pnpm build` |
| skills | `pnpm test && pnpm lint && pnpm format` |
| authkit-session | `pnpm test && pnpm run typecheck && pnpm run build && pnpm run format` |
| authkit-tanstack-start | `pnpm test && pnpm run typecheck && pnpm build && pnpm run format` |
| authkit-nextjs | `pnpm test && pnpm run typecheck && pnpm run lint && pnpm run build && pnpm run format` |

4. **Open a PR** with a conventional commit message. Reference the cross-repo task or related PRs in the description.

## Step 5: Cross-Validate Consistency

After all PRs are open, verify:

- [ ] The same logical change is applied consistently across all repos.
- [ ] No repo was missed (check against `projects.json`).
- [ ] If the change involves shared types or interfaces, all consumers are updated.
- [ ] PR descriptions cross-reference each other.

## Step 6: Merge in Order

If there's a dependency relationship:

1. Merge the upstream repo first (e.g., `authkit-session`).
2. If the downstream repos depend on a new version, update the dependency and re-run checks.
3. Merge downstream repos.

If changes are independent (e.g., README updates), merge order doesn't matter.

## Verification Checklist

- [ ] All affected repos identified from `projects.json`
- [ ] Change is consistent across all repos
- [ ] Each repo's checks pass independently
- [ ] PRs cross-reference each other
- [ ] Merged in correct dependency order (if applicable)
- [ ] All conventional commit messages match the change type

## Common Mistakes

- **Missing a repo**. Always check `projects.json` -- don't rely on memory.
- **Wrong merge order**. If `authkit-session` has a breaking change, merging a consumer first will break its CI.
- **Inconsistent changes**. If updating a convention, the exact same rule must apply everywhere.
- **Bundling unrelated changes**. Each PR should contain only the cross-repo update, nothing else.
- **Assuming encryption compatibility**. When swapping crypto libraries (e.g. `iron-session` → `iron-webcrypto`), existing sealed data may NOT be decryptable by the new library even when both claim the same format. Always: (1) wrap decryption in try-catch for graceful fallback, (2) test with a cookie created by the OLD library in the example app, (3) unit tests with freshly-sealed data will NOT catch this — they use the same library for both seal and unseal.
