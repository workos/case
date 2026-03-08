# Architecture: AuthKit Session

> `../authkit-session/` | TypeScript | pnpm
> Framework-agnostic authentication library for WorkOS.

## Overview

`@workos/authkit-session` provides the shared session management layer that framework-specific AuthKit packages build on. It handles all authentication business logic (JWT verification, token refresh, encryption) with a pluggable storage adapter pattern for framework integration.

## 3-Layer Architecture

```
Framework Package (e.g., authkit-tanstack-start)
  │ implements SessionStorage<TRequest, TResponse>
  ▼
AuthService<TRequest, TResponse>        ← orchestrator
  ├─ AuthKitCore                        ← pure business logic
  │    ├─ JWT verification (JWKS)
  │    ├─ Token refresh (WorkOS API)
  │    └─ Session encryption/decryption
  ├─ AuthOperations                     ← WorkOS API operations
  │    ├─ getAuthorizationUrl()
  │    ├─ signOut() / switchOrganization()
  │    └─ refreshSession()
  └─ SessionStorage<TReq, TRes>        ← framework adapter (injected)
```

## Key Components

### AuthService (`src/service/AuthService.ts`)

The main entry point. Coordinates core, operations, and storage.

Key methods:
- `withAuth(request)` -- validate session, auto-refresh if expired, return `AuthResult`
- `handleCallback(request, response, { code, state })` -- process OAuth callback
- `signOut(sessionId)` -- get logout URL + clear session
- `getSignInUrl()` / `getSignUpUrl()` -- authorization URLs
- `switchOrganization()` / `refreshSession()` -- session mutations

### AuthKitCore (`src/core/AuthKitCore.ts`)

Pure business logic, no framework types:
- `verifyToken(token)` -- JWT verification against WorkOS JWKS (cached)
- `parseTokenClaims(token)` -- decode JWT claims with generics
- `encryptSession(session)` / `decryptSession(encrypted)` -- iron-webcrypto
- `validateAndRefresh(session, options?)` -- validate + conditional refresh
- `refreshTokens(refreshToken, organizationId?)` -- call WorkOS API

### createAuthService Factory (`src/service/factory.ts`)

Lazy-initialization factory. Allows `configure()` to be called after instantiation:

```typescript
const authService = createAuthService({
  sessionStorageFactory: (config) => new MyFrameworkStorage(config),
});
// configure() can be called later, before first use
```

Returns a proxy that lazily delegates to the real `AuthService` on first call.

## Storage Adapter Interface

Defined in `src/core/session/types.ts`:

```typescript
interface SessionStorage<TRequest, TResponse, TOptions = unknown> {
  getSession(request: TRequest): Promise<string | null>;
  saveSession(response: TResponse | undefined, sessionData: string, options?: TOptions):
    Promise<{ response?: TResponse; headers?: HeadersBag }>;
  clearSession(response: TResponse | undefined, options?: TOptions):
    Promise<{ response?: TResponse; headers?: HeadersBag }>;
}
```

### CookieSessionStorage (`src/core/session/CookieSessionStorage.ts`)

Abstract base class implementing common cookie logic. Framework adapters extend this:

- Configures cookie options from `AuthKitConfig` (path, httpOnly, sameSite, secure, maxAge)
- `buildSetCookie(value, expired?)` -- builds Set-Cookie header string
- `applyHeaders()` -- optional override for frameworks that can mutate responses directly

**Usage**: `../authkit-tanstack-start/src/server/storage.ts` extends this class.

## Session Lifecycle

### Authentication Check (withAuth)

1. `storage.getSession(request)` -- extract encrypted cookie
2. `core.decryptSession(encrypted)` -- iron-webcrypto decrypt
3. `core.validateAndRefresh(session)` -- verify JWT, refresh if expired
4. Return `AuthResult` discriminated union:
   - `{ user: User, sessionId, accessToken, permissions, ... }` (authenticated)
   - `{ user: null }` (not authenticated or error -- graceful degradation)

### OAuth Callback (handleCallback)

1. Exchange code via `workos.userManagement.authenticateWithCode()`
2. Build `Session` object: `{ accessToken, refreshToken, user, impersonator? }`
3. `core.encryptSession(session)` -- encrypt for cookie
4. `storage.saveSession(response, encrypted)` -- set cookie
5. Parse state for `returnPathname` and custom state

### Token Refresh

- Triggered when `verifyToken()` returns false (expired JWT)
- Calls `workos.userManagement.authenticateWithRefreshToken()`
- Returns new `{ accessToken, refreshToken, user, impersonator }`
- Framework middleware persists the refreshed session via storage adapter

## Encryption

`src/core/encryption/ironWebcryptoEncryption.ts`

- Algorithm: AES-256-CBC with SHA-256 HMAC (via `iron-webcrypto`)
- Password: `WORKOS_COOKIE_PASSWORD` (minimum 32 characters)
- TTL: 0 (no time-based expiry at encryption level; cookie maxAge handles it)
- **NOT fully backward-compatible with `iron-session` v8 sealed data.** While both use `iron-webcrypto` under the hood, `iron-session`'s `sealData`/`unsealData` wrappers add their own envelope that differs from raw `iron-webcrypto`. Cookies sealed by `iron-session` will fail HMAC validation when decrypted by `iron-webcrypto` directly. Framework adapters MUST catch decryption errors gracefully (return `undefined`) so users with stale cookies are silently logged out rather than seeing errors.

## Configuration

`src/core/config.ts` + `src/core/config/ConfigurationProvider.ts`

Dual config: programmatic via `configure({...})` + environment variables (env wins).

Required:
- `clientId` / `WORKOS_CLIENT_ID`
- `apiKey` / `WORKOS_API_KEY`
- `redirectUri` / `WORKOS_REDIRECT_URI`
- `cookiePassword` / `WORKOS_COOKIE_PASSWORD`

Optional: `cookieName`, `cookieDomain`, `cookieMaxAge`, `cookieSameSite`

## Error Hierarchy

`src/core/errors.ts`

```
AuthKitError
  ├─ SessionEncryptionError   (encrypt/decrypt failures)
  ├─ TokenValidationError     (JWT verification failures)
  └─ TokenRefreshError        (refresh token API failures, includes userId/sessionId context)
```

All auth failures gracefully degrade to `{ user: null }` rather than throwing.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Public API exports |
| `src/service/AuthService.ts` | Main service, orchestrates all layers |
| `src/service/factory.ts` | Lazy-init factory with proxy |
| `src/core/AuthKitCore.ts` | Pure business logic (JWT, crypto, refresh) |
| `src/operations/AuthOperations.ts` | WorkOS API operations |
| `src/core/session/types.ts` | `SessionStorage`, `Session`, `AuthResult` types |
| `src/core/session/CookieSessionStorage.ts` | Abstract cookie storage base |
| `src/core/session/TokenManager.ts` | JWT verification + claims parsing |
| `src/core/encryption/ironWebcryptoEncryption.ts` | Session encryption |
| `src/core/config/ConfigurationProvider.ts` | Env + programmatic config |
| `src/core/errors.ts` | Error class hierarchy |
