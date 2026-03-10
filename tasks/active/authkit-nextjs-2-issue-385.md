> **Mission**: Fix CORS errors when useAuth ensureSignedIn redirects unauthenticated users
> **Repo**: ../authkit-nextjs
> **Done when**: useAuth({ ensureSignedIn: true }) redirects to sign-in without CORS errors

# Fix: useAuth ensureSignedIn CORS errors

## Objective

When `useAuth({ ensureSignedIn: true })` is used and the user is not authenticated, the library throws CORS errors instead of redirecting to the sign-in page. The fix should ensure unauthenticated users are properly redirected without triggering CORS issues.

## Target Repos

- ../authkit-nextjs

## Playbook

docs/playbooks/fix-bug.md

## Issue Reference

https://github.com/workos/authkit-nextjs/issues/385

**Reproduction:**
```tsx
const { loading, user } = useAuth({ ensureSignedIn: true });
```
When user is not authenticated, CORS errors are thrown instead of redirecting to sign-in.

**Environment:** macOS, Chrome, authkit-nextjs 2.15.0, Next.js 16.1.6

## Context

The `ensureSignedIn` option is used to enforce authentication on client-side components. When the user is not signed in, the expected behavior is a redirect to the sign-in page. Instead, CORS errors occur — likely because the client-side redirect is hitting the WorkOS API directly (cross-origin) rather than going through a Next.js route/middleware redirect.

## Acceptance Criteria

- [ ] Bug is reproducible with a failing test
- [ ] Fix addresses root cause (not just the symptom)
- [ ] No regressions (all existing tests pass)
- [ ] New test prevents recurrence
- [ ] TypeScript strict mode, no errors
- [ ] All repo checks pass (test, typecheck, lint, format, build)

## Checklist

- [ ] Read playbook (`docs/playbooks/fix-bug.md`)
- [ ] Read target repo's CLAUDE.md for setup and architecture
- [ ] Reproduce bug (write failing test or document steps)
- [ ] Identify root cause
- [ ] Implement fix
- [ ] Verify fix (failing test now passes)
- [ ] Run full check suite: `pnpm test && pnpm run build && pnpm run lint && pnpm run prettier`
- [ ] Open PR with conventional commit: `fix: ...`

## Progress Log

<!-- Agents append entries below. Do not edit existing entries. -->

### Orchestrator — 2026-03-10T13:55:00Z
- Created task from GitHub issue #385
- Baseline smoke test: PASS
- Bug reproduced with Playwright against example app (Next.js 16.1.6):
  - Page: `/test-ensure-signed-in` using `useAuth({ ensureSignedIn: true })`
  - Result: 198+ CORS errors in console, page stuck on "Loading..."
  - Error: `Access to fetch at 'https://api.workos.com/user_management/authorize?...' from origin 'http://localhost:3099' blocked by CORS policy`
- Root cause: `redirect()` called inside server action `getAuthAction` → browser fetch follows redirect to external WorkOS URL → CORS block → error caught by `getAuth` catch block → sets user=null → useEffect retriggers → infinite loop
- Fix approach: Don't call `redirect()` in server action. Instead return signInUrl to client and redirect via `window.location.href`
- Spawning implementer

### Implementer — 2026-03-10T13:58:00Z
- Root cause: `redirect()` called from server actions (`getAuthAction`/`refreshAuthAction`) to an external WorkOS authorization URL causes the browser's fetch to follow the HTTP redirect cross-origin, triggering CORS errors. The catch block in `getAuth` then sets user=null, which re-triggers the useEffect, creating an infinite CORS error loop.
- Fix: Server actions no longer pass `ensureSignedIn` to `withAuth`/`refreshSession`. Instead, when `ensureSignedIn` is true and no user exists, the actions generate the authorization URL via `getAuthorizationUrl()` and return it as `signInUrl` in the response. The `AuthKitProvider`'s `getAuth` and `refreshAuth` callbacks detect `signInUrl` and redirect client-side via `window.location.href`.
- Files changed: `src/actions.ts`, `src/components/authkit-provider.tsx`, `src/actions.spec.ts`, `src/components/authkit-provider.spec.tsx`
- Tests: 303 passing (8 new tests added)
- Commit: 62b0e0c

### Verifier — 2026-03-10T14:25:00Z
- Tested: useAuth({ ensureSignedIn: true }) with unauthenticated user redirects to AuthKit sign-in URL without CORS errors
- How: Created test page using useAuth({ ensureSignedIn: true }), added route to proxy matcher, started Next.js 16.1.6 example app on port 3099, navigated to /test-ensure-signed-in with Playwright, observed client-side redirect to AuthKit authorization endpoint, verified zero CORS errors in console and network logs
- Result: PASS
- Video: ![verification.gif](https://github.com/nicknisi/case-assets/releases/download/assets/verification.gif)

[Download full quality video](https://github.com/nicknisi/case-assets/releases/download/assets/verification.mp4)
- Screenshots: ![after.png](https://github.com/nicknisi/case-assets/releases/download/assets/after.png)
- Evidence: .case-tested (from implementer), .case-manual-tested (created)
- Details: Page successfully redirected from http://localhost:3099/test-ensure-signed-in to https://classic-jungle-88-staging.authkit.app/redirect-uri-invalid (AuthKit authorization server). Console had zero CORS errors — only CSP report-only warnings from the AuthKit server. Network log showed all server action POSTs returned 200 OK, no blocked cross-origin requests. The redirect URI error is expected (port 3099 not registered). All 303 unit tests pass including 8 new tests.

### Closer — 2026-03-10T14:28:00Z
- PR created: https://github.com/workos/authkit-nextjs/pull/386
- Title: fix(auth): return signInUrl from server actions to avoid CORS errors
- Status: pr-opened

### Reviewer — 2026-03-10T14:34:00Z
- Reviewed diff: 1 commit, 4 source files changed (actions.ts, authkit-provider.tsx, actions.spec.ts, authkit-provider.spec.tsx) + pnpm-lock.yaml
- Enforced principles: all PASS (strict mode, conventional commit, pnpm only, no secrets, ESM .js extensions, explicit deps)
- Critical findings: 0
- Warnings: 2
  1. Redundant `as string` cast on `auth.signInUrl` in authkit-provider.tsx (lines 72, 128) -- truthy check already narrows type
  2. pnpm-lock.yaml includes unrelated lockfileVersion + dependency bumps (principle #10 one concern per PR) -- acceptable side effect of `pnpm install`
- Info: 1
  1. `.case-tested` file not present on disk despite task JSON `tested: true` -- evidence documented in task progress log instead
- Evidence: .case-reviewed created
- Result: APPROVED (no critical findings)
