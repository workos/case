# Add AuthKit Framework: {framework-name}

## Objective

Create `@workos/authkit-{framework-name}`, a new AuthKit integration for {framework-name}. This package provides middleware, session management, server helpers, and React client components for authentication in {framework-name} applications.

## Target Repos

- {../authkit-{framework-name}} (new repo to create)

## Playbook

docs/playbooks/add-authkit-framework.md

## Context

{Describe the target framework, its middleware system, how it handles SSR, and any framework-specific considerations. Link to framework docs.}

Framework: {framework-name} {version}
Middleware mechanism: {describe how the framework intercepts requests}
Cookie access: {describe the framework's request/response API for cookies}
SSR data passing: {describe how server data reaches client components}
Router: {describe the framework's client-side router for navigation}

## Acceptance Criteria

- [ ] Storage adapter extends `CookieSessionStorage` from `@workos/authkit-session`
- [ ] `authkitMiddleware()` intercepts requests and validates/refreshes sessions
- [ ] `getAuth()` returns auth state with graceful degradation (`{ user: null }` on failure)
- [ ] `handleCallbackRoute()` completes OAuth flow (code exchange, cookie, redirect)
- [ ] `signOut()` clears session and provides logout URL
- [ ] `getSignInUrl()` and `getSignUpUrl()` return correct authorization URLs
- [ ] `AuthKitProvider` renders React context with auth state
- [ ] `useAuth()` and `useAccessToken()` hooks work client-side
- [ ] Tests pass in both server (`node`) and client (`happy-dom`) environments
- [ ] TypeScript strict mode, no errors
- [ ] ESM with `.js` extensions on all imports
- [ ] No framework-agnostic logic duplicated from `authkit-session`
- [ ] Build succeeds
- [ ] AGENTS.md present at repo root

## Checklist

- [ ] Read playbook (`docs/playbooks/add-authkit-framework.md`) and architecture docs
- [ ] Read `../authkit-tanstack-start/` as reference implementation
- [ ] Scaffold repo structure (package.json, tsconfig, vitest.config.ts)
- [ ] Implement storage adapter (`src/server/storage.ts`)
- [ ] Create auth service via `createAuthService()` factory
- [ ] Implement middleware (`src/server/middleware.ts`)
- [ ] Implement server helpers (`src/server/server-functions.ts`)
- [ ] Implement callback handler (`src/server/server.ts`)
- [ ] Implement AuthKitProvider (`src/client/AuthKitProvider.tsx`)
- [ ] Implement hooks (`src/client/useAccessToken.ts`, `src/client/useTokenClaims.ts`)
- [ ] Write tests for all server and client modules
- [ ] Add AGENTS.md
- [ ] Run `pnpm test && pnpm typecheck && pnpm build && pnpm format`
- [ ] Open PR with conventional commit: `feat: initial authkit-{framework-name} integration`

## Progress Log

<!-- Agents append entries below. Do not edit existing entries. -->
