# Playbook: Add a New AuthKit Framework Integration

> Reference: [docs/architecture/authkit-framework.md](../architecture/authkit-framework.md), [docs/architecture/authkit-session.md](../architecture/authkit-session.md)
> Template repo: `../authkit-tanstack-start/` (fully consumes authkit-session)
> Session layer: `../authkit-session/`

## Prerequisites

Before starting, confirm:

- You understand the target framework's middleware system, cookie API, and routing.
- You understand how the framework handles SSR (server-to-client data passing).
- You have read `docs/architecture/authkit-session.md` to understand the 3-layer architecture.
- The `@workos/authkit-session` package is published and available.

## Step 1: Scaffold the Repository

Mirror `../authkit-tanstack-start/` structure:

```
authkit-{framework}/
  src/
    index.ts                          # Public API re-exports
    server/
      index.ts                        # Server-side exports
      storage.ts                      # CookieSessionStorage adapter
      middleware.ts                    # authkitMiddleware() factory
      server.ts                       # handleCallbackRoute()
      server-functions.ts             # getAuth, signOut, getSignInUrl, etc.
      context.ts                      # Framework-specific context passing
    client/
      index.ts                        # Client-side exports
      AuthKitProvider.tsx             # React context provider
      useAccessToken.ts              # Client hook
      useTokenClaims.ts              # Client hook
      types.ts                        # Client-side types
  package.json
  tsconfig.json
  vitest.config.ts
  AGENTS.md
  README.md
```

### package.json Essentials

```json
{
  "name": "@workos/authkit-{framework}",
  "type": "module",
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./server": { "import": "./dist/server/index.js", "types": "./dist/server/index.d.ts" },
    "./client": { "import": "./dist/client/index.js", "types": "./dist/client/index.d.ts" }
  },
  "peerDependencies": {
    "@workos/authkit-session": "^x.x.x",
    "{framework-package}": "^x.x.x"
  }
}
```

- Use `pnpm` as package manager.
- ESM with `.js` extensions on all relative imports.
- `"strict": true` in tsconfig.json (Golden Principle #1).

## Step 2: Implement the Storage Adapter

Create `src/server/storage.ts`.

Extend `CookieSessionStorage<TRequest, TResponse>` from `@workos/authkit-session`:

```typescript
import { CookieSessionStorage } from '@workos/authkit-session';
import type { AuthKitConfig, HeadersBag } from '@workos/authkit-session';

export class FrameworkCookieSessionStorage extends CookieSessionStorage<Request, Response> {
  constructor(config: AuthKitConfig) {
    super(config);
  }

  async getSession(request: Request): Promise<string | null> {
    // Extract the session cookie from the framework's request object.
    // Use the cookie name from this.cookieName.
  }

  async applyHeaders(
    response: Response | undefined,
    headers: HeadersBag,
  ): Promise<{ response?: Response; headers?: HeadersBag }> {
    // Apply Set-Cookie and other headers to the framework's response object.
  }
}
```

Reference: `../authkit-tanstack-start/src/server/storage.ts` for the concrete implementation.

## Step 3: Create the Auth Service

Create `src/server/context.ts` (or wherever the service is initialized).

Use `createAuthService` from `@workos/authkit-session`:

```typescript
import { createAuthService } from '@workos/authkit-session';
import { FrameworkCookieSessionStorage } from './storage.js';

export const authService = createAuthService({
  sessionStorageFactory: (config) => new FrameworkCookieSessionStorage(config),
});
```

The factory pattern allows lazy initialization -- `configure()` can be called later before first use.

## Step 4: Implement Middleware

Create `src/server/middleware.ts`.

Export `authkitMiddleware(options?)` that returns the framework's middleware type.

Inside the middleware:
1. Call `authService.withAuth(request)` to validate/refresh the session.
2. Pass the `AuthResult` downstream via the framework's context system.
3. Apply any response headers returned by `withAuth` (for token refresh Set-Cookie).

Reference: `../authkit-tanstack-start/src/server/middleware.ts`.

## Step 5: Implement Server Helpers

Create `src/server/server-functions.ts`.

Export these functions (all delegate to `authService`):

| Function | Delegates to |
|----------|-------------|
| `getAuth()` | `authService.withAuth(request)` |
| `getSignInUrl()` | `authService.getSignInUrl()` |
| `getSignUpUrl()` | `authService.getSignUpUrl()` |
| `signOut()` | `authService.signOut(sessionId)` |
| `switchToOrganization()` | `authService.switchOrganization()` |

Create `src/server/server.ts` for the OAuth callback handler:

```typescript
export async function handleCallbackRoute(request, response) {
  // Extract code and state from URL search params
  // Call authService.handleCallback(request, response, { code, state })
  // Redirect to returnPathname from state
}
```

## Step 6: Implement the Provider and Hooks

### AuthKitProvider (`src/client/AuthKitProvider.tsx`)

React context component that:
1. Accepts `initialAuth` prop from the server (loader/SSR data).
2. Provides auth state via React context.
3. Monitors `document.visibilitychange` to refresh auth when tab regains focus.
4. Uses the framework's router for navigation (sign-in redirects).

Reference: `../authkit-tanstack-start/src/client/AuthKitProvider.tsx`.

### Hooks

- `useAuth()` -- returns auth state from the provider context.
- `useAccessToken()` -- returns current access token (with optional auto-refresh).
- `useTokenClaims()` -- decodes and returns JWT claims.

Reference: `../authkit-tanstack-start/src/client/useAccessToken.ts`, `useTokenClaims.ts`.

## Step 7: Add Tests

Use vitest with multi-environment config:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    globals: true,
    projects: [
      { test: { name: 'server', environment: 'node', include: ['src/server/**/*.spec.*'] } },
      { test: { name: 'client', environment: 'happy-dom', include: ['src/client/**/*.spec.*'] } },
    ],
  },
});
```

Test files co-located with source (`.spec.ts` / `.spec.tsx`).

Must test:
- Storage adapter: cookie extraction, header application
- Middleware: auth result propagation, token refresh flow
- Server functions: sign-in URL generation, sign-out, org switching
- Callback handler: code exchange, cookie setting, redirect
- Provider: initial auth rendering, visibility change
- Hooks: access token retrieval, claims parsing

Mock `@workos/authkit-session` internals (AuthService, AuthKitCore).

## Step 8: Add AGENTS.md

Create `AGENTS.md` at repo root. Include:
- Setup: `pnpm install`
- Build: `pnpm build`
- Test: `pnpm test`
- Architecture summary referencing key files
- Link to `docs/architecture/authkit-framework.md` in the case repo

## Step 9: Configure CI and Release

- Add GitHub Actions workflow for test/typecheck/build.
- Configure release-please if using automated releases.
- Ensure `pnpm-lock.yaml` is committed (no npm/yarn).

## Step 10: Run All Checks

```bash
pnpm test           # all tests pass
pnpm typecheck      # TypeScript strict mode, no errors
pnpm build          # compiles cleanly
pnpm format         # formatter passes
```

## Step 11: Open PR

- Commit: `feat: initial authkit-{framework} integration`
- PR should include the full package, tests, AGENTS.md.
- Follow [PR conventions](../conventions/pull-requests.md).

## Verification Checklist

- [ ] Storage adapter correctly extends `CookieSessionStorage`
- [ ] `authkitMiddleware()` intercepts requests and passes auth context
- [ ] `getAuth()` returns `{ user }` or `{ user: null }` (graceful degradation)
- [ ] `handleCallbackRoute()` completes OAuth flow and sets cookie
- [ ] `signOut()` clears session and returns logout URL
- [ ] `AuthKitProvider` renders children with auth context
- [ ] `useAuth()` returns current auth state
- [ ] All tests pass in both server (node) and client (happy-dom) environments
- [ ] TypeScript strict mode, no errors
- [ ] ESM with `.js` extensions on all imports
- [ ] No framework-agnostic logic duplicated from authkit-session

## Common Mistakes

- **Duplicating session logic**. JWT verification, token refresh, and encryption belong in `authkit-session`. The framework package only implements storage + glue.
- **Throwing on auth failure**. Auth checks must return `{ user: null }`, not throw (Golden Principle #11).
- **Missing `.js` extensions**. ESM requires them on all relative imports.
- **Wrong test environment**. Server tests need `node`, client tests need `happy-dom` or `jsdom`.
- **Not handling token refresh headers**. When `withAuth` refreshes a token, it returns headers that must be applied to the response.
