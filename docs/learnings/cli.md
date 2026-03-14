# CLI Learnings

Tactical knowledge from completed tasks. Read by agents before working in this repo.

<!-- Retrospective agent appends entries below. Do not edit existing entries. -->

### 2026-03-09 — auto-env-after-login (cli-1)
- `staging-api.ts` has `fetchStagingCredentials(accessToken)` — reusable for any flow needing staging env setup
- `config-store.ts` `saveConfig()` accepts `EnvironmentConfig` — use for programmatic env creation
- `login.ts` OAuth flow already requests `staging-environment:credentials:read` scope — no scope changes needed for staging API calls post-login
- Non-fatal wrapping pattern: wrap side-effect calls in try/catch returning boolean, print hint on failure — used successfully in `provisionStagingEnvironment()`
- CLI-only changes (no frontend UI) can skip Playwright verification — verifier code review + test execution is sufficient

### 2026-03-10 — one-shot-mode (cli-2)
- `config-store.ts` `EnvironmentConfig` supports extending with new fields (e.g., `claimToken`, `unclaimed` type) — add type guard helpers like `isUnclaimedEnvironment()` alongside
- `bin.ts` is the command registration hub — wire new commands there AND in `utils/help-json.ts` (both must be updated together)
- `env-writer.ts` already has `generateCookiePassword()` — check before duplicating in new modules (was duplicated in `one-shot-api.ts`)
- `run-with-core.ts` handles management command middleware — use it for cross-cutting concerns like unclaimed environment warnings
- Multi-phase ideation: each phase should add tests for ALL files it modifies, including pre-existing spec files like `env.spec.ts` and `help-json.spec.ts` — the reviewer will flag gaps
- CLI uses `oxfmt` for formatting (`pnpm format`) — implementer MUST run this as part of validation. Missing it requires a follow-up commit.
