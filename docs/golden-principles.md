# Golden Principles

Invariants that must hold across all WorkOS OSS repos. Each is marked **enforced** (scriptable, can be checked automatically) or **advisory** (requires human judgment).

---

## 1. TypeScript strict mode is always on
**[enforced]** Every repo's `tsconfig.json` must have `"strict": true`. No exceptions, no per-file overrides.

Check: `grep '"strict": true' tsconfig.json`

## 2. Tests must pass on the default branch
**[enforced]** `pnpm test` must exit 0 on `main`/`master` at all times. Breaking the default branch blocks everyone.

Check: `pnpm test`

## 3. Conventional commits for all changes
**[enforced]** Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/). This drives changelogs and release automation.

Check: `git log --oneline -1 | grep -E '^[a-f0-9]+ (feat|fix|chore|refactor|docs|test|ci|perf|build|style|revert)(\(.+\))?!?:'`

## 4. pnpm is the only package manager
**[enforced]** No npm, no yarn. All repos use pnpm. Lock files must be `pnpm-lock.yaml`.

Check: `test -f pnpm-lock.yaml && ! test -f package-lock.json && ! test -f yarn.lock`

## 5. No secrets in source control
**[enforced]** `.env`, `.env.local`, credentials files must be in `.gitignore`. API keys (`sk_*`), cookie passwords, and tokens must never be committed.

Check: `! git ls-files | grep -E '\.env(\.local)?$'`

## 6. Formatter must pass before merge
**[enforced]** Each repo has a format check command. It must exit 0 before merging.

Check: `pnpm format` or `pnpm prettier` (per repo)

## 7. Build must succeed (where applicable)
**[enforced]** Repos with a `build` script must compile cleanly. cli, authkit-nextjs, authkit-session, authkit-tanstack-start all have build steps.

Check: `pnpm build` (where defined in package.json)

## 8. Public API changes require test coverage
**[advisory]** Any new or modified exported function/type must have corresponding test coverage. Library packages (authkit-*) target 80% coverage.

## 9. Source files should stay under 300 lines
**[advisory]** Keep individual source files focused. Files over 300 lines are a signal to split. Test files are exempt. Known exceptions: `../cli/main/src/bin.ts`.

## 10. One concern per commit, one concern per PR
**[advisory]** Don't mix features with refactors. Don't bundle unrelated fixes. Small, focused changes are easier to review and revert.

## 11. Graceful degradation over hard failures
**[advisory]** Auth checks should return `{ user: null }` rather than throwing. CLI should output structured errors, not crash. Users should never see raw stack traces in production paths.

## 12. Framework-agnostic logic belongs in authkit-session
**[advisory]** JWT verification, token refresh, session encryption, and auth operations should live in `authkit-session`. Framework packages implement only the storage adapter and framework-specific glue.

## 13. Skills must start with "fetch docs first"
**[advisory]** Every skill and topic file in the skills repo must begin by fetching official documentation. The fetched docs are the source of truth; skills provide supplementary guidance (gotchas, decision trees, verification).

## 14. ESM with .js extensions in imports
**[enforced]** All repos target ESM. Relative imports must use `.js` extensions for Node ESM resolution.

Check: `grep -rn "from '\./.*[^s]'" src/ | grep -v "\.js'" | grep -v "\.json'" | grep -v node_modules`

## 15. Dependencies must be explicitly declared
**[enforced]** No implicit peer deps. If code imports a package, it must appear in `dependencies` or `peerDependencies` in `package.json`.

Check: Compare import statements against package.json dependencies.

## 16. Session decryption must be fault-tolerant
**[enforced]** Any code that decrypts session cookies or headers must catch decryption errors and return `undefined`/`null` (graceful "no session") rather than throwing. This ensures that library upgrades that change encryption backends (e.g. `iron-session` → `iron-webcrypto`) don't crash for users with existing cookies — they get silently logged out and re-authenticate instead.

Check: Every call to `unsealData` / `decryptSession` must be wrapped in try-catch.

## 17. Manual verification after encryption changes
**[advisory]** When changing session encryption/decryption libraries, agents must test with existing cookies from the previous library version. The sealed formats may differ in HMAC, padding, or key derivation even when both claim "iron" compatibility. A production build test with a pre-existing session cookie is required — unit tests with freshly sealed data will NOT catch this class of bug.
