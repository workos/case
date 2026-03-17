# AuthKit Session Learnings

Tactical knowledge from completed tasks. Read by agents before working in this repo.

<!-- Retrospective agent appends entries below. Do not edit existing entries. -->

- **2026-03-16** — `repo type`: `authkit-session` is a pure TypeScript library with no web UI. Playwright manual testing is not applicable — the test suite (Vitest) is the authoritative verification mechanism. Do not attempt to link the library to an example app for Playwright evidence when working in this repo alone. (from task authkit-session-1-session-encoding-migration)

- **2026-03-16** — `coverage threshold`: Global branch coverage (78.28%) is below the documented 80% threshold but `pnpm run test:coverage` exits 0. Pre-existing gap is in `factory.ts` (37.5% function coverage) and `CookieSessionStorage.ts` (62.5% branch coverage) — both untouched by recent work. Do not treat coverage exit code 0 as evidence the threshold is met; check actual percentages manually if coverage is a concern. (from task authkit-session-1-session-encoding-migration)
