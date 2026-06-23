# Migration: Custom DAG + Event-Sourcing → LangGraph + Langfuse

**Status:** **COMPLETE** — Phase 1 (1.1–1.3) + Phase 2 (2.1–2.2) all landed. The custom DAG and the granular event-sourcing log are gone; LangGraph + checkpointer own orchestration/resume; Langfuse is the sole observability sink. See §0.
**Author:** Case maintainers
**Scope:** Replace Case's hand-rolled orchestration engine and granular event log with LangGraph (graph execution + checkpointing) and Langfuse (observability dispatch), without losing any existing feature.

---

## 0. Migration Status (handoff log)

> Running log of what has actually landed, with deviations from the plan called out. Update this section as each step completes.

### ✅ Phase 1.1 — Wrap pi as a LangGraph node (parallel path, flag-gated) — **DONE**

LangGraph (`@langchain/langgraph` 1.4.4 + peer `@langchain/core` 1.2.0, Bun-verified) now drives orchestration behind `CASE_ENGINE=langgraph`. Legacy DAG executor remains the **default**; nothing in the default path changed behaviorally.

**Landed:**

- **`src/pipeline-dispatch.ts` (NEW).** Extracted `dispatchNode` / `consultMatrix` / `handleFailure` / `PipelineCallbacks` out of `pipeline.ts`. Both engines call this one dispatcher, so per-phase semantics (matrix consult, abort prompts via `handleFailure`, scout findings hand-off, `previousResults` bookkeeping) are **identical by construction**. First param generalized to `DispatchNodeRef = { phase, startedAt? }` (legacy `DagNode` is assignable).
- **`src/langgraph/state.ts` (NEW).** `StateGraph` channels: `cycle`, `revisionCycles`, `pendingRevision`, `fingerprints` (Record), `last`, `evaluator`, `decision`, `revisionClosed`. Holds **orchestration** state only — agent context (scout findings, `previousResults`) and run-level `outcome`/`failedAgent` stay in the shared pipeline closure exactly as legacy keeps them. _(This is the object the 1.2 checkpointer will snapshot.)_
- **`src/langgraph/engine.ts` (NEW).** `executeLangGraph(...)` reproduces scout→implement→verify→review→close→retrospective with the revision loop, fingerprint short-circuit, revision-budget cap, and failure→retrospective routing via conditional edges. Emits the **same event stream** through the existing `EventAppender`, so td-status mirror, evidence markers, metrics, and `runs.jsonl` stay correct **for free** (the appender's `projectTaskJson`/`projectMarkers` is the single projection seam — no shadow DAG needed).
- **`src/pipeline.ts`.** Branches on `CASE_ENGINE` inside `runPipelineBody`. Shared `dispatch` closure hoisted; legacy graph build/resume/`executeGraph` moved into the `else`. −282 LOC net (dispatcher relocated).
- **`src/__tests__/langgraph-parity.spec.ts` (NEW).** Runs both engines over an identical mock runtime, asserts identical `(phase, outcome)` sequence (and pins each to an explicit expected). 6 cases: standard happy, tiny profile-skip, verifier revision, reviewer soft-fail revision, budget-exhausted (`maxRevisionCycles=1`), fingerprint short-circuit. **6/6 green.**

**Validation:** typecheck ✅ · `oxlint` ✅ · AST self-lint ✅ · `oxfmt` ✅ · parity 6/6 ✅ · legacy `pipeline.spec` 24/24 unchanged ✅ · full suite green (see test-runner note below).

**Deviations / decisions made during implementation:**

1. **Resume under `langgraph` is deferred to 1.2.** 1.1 is fresh-runs-only on the LangGraph path; event-log crash-resume stays legacy-only until the SQLite checkpointer lands. A td-persisted `pendingRevision` still seeds resume-at-implement (passed as `initialPendingRevision`, seeds `cycle`/`revisionCycles`).
2. **Replicated a legacy quirk for true parity.** When a **verify** failure is _denied_ revision (budget exhausted or fingerprint match), the legacy executor still runs that cycle's **review** before closing — skipping the next cycle unblocks `verifyPassedPredicate`. The engine reproduces this: `revise` routes a denied verify-failure to `review` first (guarded by the `revisionClosed` channel so that trailing review can't itself re-trigger revision). A _review_-triggered denial closes directly (review already ran).
3. **`status_changed` is computed per-phase** (implement→implementing, verify→verifying, …, post-close→pr-opened) rather than via `projectStatusFromGraph`. The sequential engine never has verify+review running concurrently, so the legacy `evaluating` (concurrent) status is not emitted on the LangGraph path. Does not affect phase-outcome parity; revisit if a profile widens to true parallel supersteps.
4. **Skipped-phase `phase_end` events are not emitted** on the failure path (legacy emits `outcome:'skipped'` for bypassed pending nodes). Parity is asserted on _executed_-phase outcomes. If `projectMetrics`' `skippedPhases` fidelity matters under LangGraph, emit these in 1.3 when marker/td writes go node-direct.

**Test-runner fix (`src/dev/run-tests.ts`) — required, not optional.** Bun's `mock.module()` is process-global and persists across files; `bun test ./src/__tests__/` loaded all specs into one process, so top-level mocks leaked (`pipeline-tool.spec`'s `pipeline.js` mock broke `pipeline.spec`/parity; `pipeline.spec`'s `task-store` mock broke `task-scanner`/`createTask`/`update-memory`). This was **pre-existing** (38 failures on clean HEAD). Fixed by running each unit spec in its own process (concurrency 8). Every spec passes in isolation; the suite is green. **Next session: keep specs isolated — do not collapse back to a single `bun test <dir>` invocation.**

### ✅ Phase 1.2 — Checkpointer + resume parity (additive, flag-gated) — **DONE**

The LangGraph path now owns crash/abort resume via a SQLite checkpointer; the 1.1 "fresh-runs-only" limitation is gone. Legacy event-replay resume is untouched (still the default-engine path). `events-reducer.spec` is **retained** as the resume-correctness oracle until the 1.3 cutover.

**Landed:**

- **`src/langgraph/checkpointer.ts` (NEW).** `BunSqliteSaver extends BaseCheckpointSaver`, a faithful port of the upstream `@langchain/langgraph-checkpoint-sqlite` schema + serde contract onto **`bun:sqlite`**. `getTuple`/`list`/`put`/`putWrites`/`deleteThread` + default serde. `createSqliteCheckpointer(repoPath)` opens the DB at the **§6-decided** location.
- **`src/langgraph/engine.ts`.** `executeLangGraph` accepts `checkpointer` + `threadId`; compiles the graph with the checkpointer when present. Resume decision: `getState().next.length > 0` ⟹ a prior run was interrupted mid-superstep → `invoke(null)` (continue from saved state); otherwise `invoke(initial)` (td-seeded fresh run). `deleteThread` runs on **normal completion only**, so only a true crash/abort leaves a resumable checkpoint — this mirrors the legacy `outcome === 'running'` resume gate exactly. A stale terminal checkpoint (crash during a prior cleanup) is cleared before a fresh run.
- **`src/pipeline.ts`.** The `langgraph` branch constructs the checkpointer (`createSqliteCheckpointer(config.repoPath)`), passes `threadId: task.id`. td still seeds the first run's `pendingRevision`; the checkpoint is authoritative once a run has begun.
- **`src/__tests__/checkpointer.spec.ts` (NEW).** SQL-layer correctness: roundtrip, latest-wins ordering + parent linkage, pending writes, list ordering/limit, `deleteThread`, and **persistence across a reopen on the same file** (new `Database` instance = new-process resume). 6/6 green.
- **`src/__tests__/checkpointer-resume.spec.ts` (NEW).** The Phase 1.2 oracle: kill mid-`implement_1` (the implementer throws on the revision cycle, escaping `invoke` — `runPhase` wraps dispatch in `try/finally`, no catch). A second `executeLangGraph` over the same `MemorySaver` + thread resumes, re-enters at `implement` (not `scout`), carries the restored revision, and that restored `(revisionCycles, pendingRevision)` **matches `reduceEvents` on the pre-crash event stream**. Plus: a clean run drops its thread. 2/2 green.

**Validation:** typecheck ✅ · `oxlint` 0 errors ✅ · AST self-lint ✅ · `oxfmt` (my files) ✅ · checkpointer 6/6 ✅ · resume-parity 2/2 ✅ · parity 6/6 unchanged ✅ · `pipeline.spec` unchanged ✅ · full suite green ✅. No manifest/lockfile churn (`@langchain/langgraph-checkpoint` was already a dep; the transient `better-sqlite3` add/trust was fully backed out, incl. `trustedDependencies`).

**Change set:** `src/langgraph/checkpointer.ts` (NEW), `src/__tests__/checkpointer.spec.ts` (NEW), `src/__tests__/checkpointer-resume.spec.ts` (NEW), `src/langgraph/engine.ts` (edited), `src/pipeline.ts` (edited). Branch `docs/migrate-langgraph-langfuse-rfc` — **not yet committed** at handoff.

**Deviations / decisions made during implementation:**

1. **§6 co-location — RESOLVED to a sibling DB, not co-located.** td owns `<repo>/.todos/issues.db` and runs 29 versioned schema migrations with **no namespace isolation** (a future td migration could drop foreign tables). The checkpointer therefore lives in a **sibling** `<repo>/.todos/case-checkpoints.db` — the §6 fallback — keeping the two schemas independently owned and recoverable.
2. **Official SQLite checkpointer is unusable under Bun → custom `bun:sqlite` saver.** `@langchain/langgraph-checkpoint-sqlite@1.0.3` depends on `better-sqlite3`, whose native binding fails to load under Bun (`ERR_DLOPEN_FAILED`, oven-sh/bun#4290 — Bun itself recommends `bun:sqlite`). Ported the schema/serde contract by hand. Scope is **current format only (v4)**: the legacy `pending_sends` + `migratePendingSends` path (for v<4 checkpoints) and `list()` metadata filtering are omitted — the engine never persists v<4 nor lists by filter. Neither package nor `better-sqlite3` ships in `package.json`.
3. **`thread_id = task.id`; thread dropped on normal completion.** A stable per-task key lets an interrupted run of the same task resume; `deleteThread` on reaching `END` means a completed/failed run leaves nothing resumable (only crashes/aborts do). This reproduces the legacy "resume iff `outcome === 'running'`" semantics without a separate gate.
4. **Resume seed precedence.** The td-persisted `pendingRevision` seeds **fresh** runs only (`invoke(initial)`); on resume the checkpoint is authoritative and `invoke(null)` continues from it.
5. **No "dual-write" — parity proven by an in-process oracle instead.** §4 step 1.2 anticipated running both resume mechanisms side-by-side. What landed: each engine uses its own resume (legacy path = event replay; langgraph path = checkpointer); they are not both exercised in a single run. The §4 "assert restored graph state matches `reduceEvents` on the same crash point" guarantee is delivered by `checkpointer-resume.spec` — it crashes the LangGraph run mid-`implement_1` and asserts the checkpointer-restored `(revisionCycles, pendingRevision)` equals `reduceEvents` over the pre-crash event stream. Functionally the §4 acceptance; mechanically a test, not a runtime dual-write.

### ✅ Phase 1.3 — ⚠ BREAKING: resume cutover + default flip — **DONE**

LangGraph is now **unconditional**. The legacy DAG executor/builder, the event-replay resume path, and the `CASE_ENGINE` flag are gone; resume is checkpointer-only; the td mirror + evidence markers are written **node-direct** by the engine. The granular `run-*.jsonl` is still **written** (write-only observability sink until 2.2). Full suite green.

**Landed (two commits' worth; the flip is the single ⚠ BREAKING change):**

- **`src/pipeline.ts`.** `runPipelineBody` no longer branches on `CASE_ENGINE` — the LangGraph path is the only path. Deleted: the `else` block, the legacy resume block (`readdirFs`→`loadEventsFromFile`→`reduceEvents`→`restoreGraphState`→`appender.restoreState`), and the three seed helpers (`markCyclesCompleted`/`seedGraphFromTaskStatus`/`seedPendingRevision`). A td-persisted `pendingRevision` now seeds **`appender.getState().revisionCycles`** directly (ported from the legacy lines 197-199) so metrics + the retrospective snapshot see the pre-crash cycles even though no new `revision_requested` fires on a resumed run. The engine receives `store` + `caseRoot` for the node-direct writes.
- **Deleted modules:** `src/dag/{builder,executor,restore,status,types}.ts`. **KEPT (MOVE-verbatim, §9):** `src/dag/{fingerprint,merge,outcome-table}.ts` — still imported by the engine/dispatch. `src/dag/` now holds only those three.
- **`src/langgraph/projection.ts` (NEW).** `projectNodeState(state, store, caseRoot)` — the td-mirror + marker writer lifted verbatim out of `EventAppender.runProjections`. The engine calls it twice per phase in `runPhase`: once after `phase_start`+`emitStatus` (surfaces the running phase/status to td before the long dispatch) and once after `phase_end` (flips agent status to completed/failed and drops the `tested`/`reviewed` marker file in the same tick). Read source is still `PipelineState` via `appender.getState()` (the appender keeps maintaining it until 2.2); only the call site moved off the event hop.
- **`src/events/appender.ts`.** Now a **write-only JSONL sink + state container**: `runProjections` and the `projectTaskJson`/`projectMarkers` imports are gone, the `taskStore` ctor param is gone, and `restoreState` (dead with replay resume) was removed. `append()` = validate → write line → `applyEvent`. `getState()` still backs metrics + retrospective.
- **`src/langgraph/engine.ts`.** `LangGraphEngineArgs` gains `store` + `caseRoot`; `phaseStatus` is now **exported** (ported status-projection oracle).

**Test triage (§9):**

- **DIE (deleted):** `dag-builder.spec`, `dag-builder-scout.spec`, `dag-executor.spec`.
- **PORT:** `dag-status.spec` → **`phase-status.spec`** (asserts the engine's exported `phaseStatus` phase→status map; the legacy concurrent `evaluating` + graph-derived `merged` are intentionally absent — 1.1 deviation 3). `events-projections.spec` **kept as-is** (the projection functions are pure and unchanged until 2.2); the node-direct _write_ behavior is the new `node-projection.spec`. `pipeline.spec` resume parts: the pendingRevision-seed resume tests **pass unchanged** (engine seeds from `initialPendingRevision`); the legacy **status-only** re-entry test was **deleted** (see deviation 1).
- **Converted:** `langgraph-parity.spec` → single-engine **routing oracle** (the legacy arm it compared against is gone; the 6 pinned `(phase, outcome)` sequences now stand alone as the conditional-edge contract — this is the §9 NET-NEW routing test).
- **Trimmed:** `events-appender.spec` lost its 3 projection/marker tests (moved to `node-projection.spec`) and the `restoreState` test; the append/sequence/runId/state coverage stays.
- **NET-NEW:** `node-projection.spec` (td write + marker-file drop + re-projection + dedupe — the evidence-gate coverage §9 requires node-direct).
- **Retained:** `events-reducer.spec` — `reducer.ts` is alive until 2.2 (the appender's `applyEvent` + the `checkpointer-resume.spec` oracle both depend on it). Retire with the rest at 2.2.
- **Fixed:** `checkpointer-resume.spec` now passes the engine a no-op `store` + `caseRoot` and a valid-enough stub state (empty phases/markers → no marker files, one no-op td write).

**Validation:** typecheck ✅ · `oxlint` 0 errors (1 pre-existing warning in `interview/session.ts`) ✅ · AST self-lint ✅ · `oxfmt` ✅ · full suite **47 unit specs + 9 standalone, 0 fail** (`src/dev/run-tests.ts`, process-isolated) ✅. Branch `docs/migrate-langgraph-langfuse-rfc` — **not yet committed** at handoff (consistent with 1.1/1.2).

**Deviations / decisions made during implementation:**

1. **Legacy status-only resume dropped (by design).** `seedGraphFromTaskStatus` let a run resume mid-pipeline from a coarse td status with **no checkpoint** (e.g. td says `verifying` → skip to verify). Checkpointer-only resume removes this: with no checkpoint, a run starts fresh from scout. This is intentional per §5 decision 1 (td is a human mirror, **not** a resume source) — a genuinely interrupted run _has_ a checkpoint and resumes correctly (`checkpointer-resume.spec`). The `pipeline.spec` test `re-entry from verifying status skips implement phase` was deleted; td-persisted **pendingRevision** seeding survives.
2. **Two projections per phase, not per event.** `projectNodeState` fires at `phase_start` (running mirror) and `phase_end` (completed + markers), vs the appender's old fire-on-every-`append`. This preserves the live "running" td status while dropping the event-hop coupling. `pendingRevision` in td is now written at the next implement's `phase_start` (state carries it from the `revision_requested` reducer) plus dispatch's direct `store.setPendingRevision` calls — net final td state unchanged.
3. **TS narrowing workaround.** With the legacy in-scope failed-node loop gone, TS control-flow analysis narrows `outcome` to its `'completed'` initializer (it can't see the dispatch/`onPhaseFailed` closures mutate it). The final `if` reads `(outcome as string) === 'failed'` to keep the runtime failure branch.
4. **Carried open item (1.1 deviation 4):** skipped-phase `phase_end` events are **still not emitted**. `projectMetrics.skippedPhases` fidelity is therefore unchanged by this phase. If wanted, emit them from the engine when a profile bypasses a node — deferred (no current consumer).

### ✅ Phase 2.1 — Langfuse dispatch at the subscriber seam (additive, fire-and-forget) — **DONE**

Langfuse now receives a per-run trace fed from the single observability seam (`pi-adapter`), **additive** alongside the JSONL appender (dual until 2.2). No orchestration change; the control path never reads back (§7). Disabled (tracer `null`) when keys absent → Case runs exactly as before, JSONL-only.

**Landed:**

- **`src/tracing/langfuse.ts` (NEW).** `createLangfuseTracer(runId, task)` → `LangfuseTracer | null` (null when public/secret keys absent). One trace per run; `startAgentSpan(agent, phase)` opens a phase span; `AgentSpan` exposes `generation`/`toolStart`/`toolEnd`/`event`/`score`/`end`. `mapUsage` maps pi `usage` → Langfuse `usageDetails`/`costDetails` (snake_case; `total` summed by ingest). **Every method is self-defensive** (swallows its own error, logs, returns a `NOOP_SPAN` on span-open failure) — the §7 invariant that an unreachable/slow sink is a no-op rests here. `flushSafely` fire-and-forget; `shutdownSafely(timeoutMs=3000)` races shutdown against a timeout so a hung sink can't stall teardown.
- **`src/agent/adapters/pi-adapter.ts`.** At the existing `agent.subscribe` seam: `turn_end` → `span.generation(message)` (per-call tokens **and** pre-computed cost); `tool_execution_start/end` → nested `span.toolStart`/`toolEnd`; on completion `result.rubric` → `span.score`, then `span.end`; on throw `span.end(..., true)`. `onToolActivity`/`onHeartbeat` TUI feed left **untouched** (§1 constraint 3) — Langfuse calls sit beside them, not in front.
- **`src/pipeline.ts`.** Builds the tracer (`createLangfuseTracer(runId, { id: task.id })`), threads it via `config.langfuse`, and `await langfuse?.shutdownSafely()` at teardown (bounded; retrospective still reads local `runs.jsonl` only).
- **Tracer plumbing (the rest of the diff).** `src/types.ts` adds `langfuse?: LangfuseTracer | null` to **both** `PipelineConfig` and `SpawnAgentOptions`. Each phase entry (`src/phases/{scout,verify,review,close,retrospective}.ts`) passes `langfuse: config.langfuse` into its `spawn` options so every phase's agent emits to the per-run trace (+1 line each). `package.json` + `bun.lock` add the `langfuse` (^3.38) dependency. `.gitignore` adds `.env` (local secrets for the compose stack).
- **`.env.example` (NEW) + `podman-compose.yaml`.** Self-hosted stack template (headless init provisions org/project/keys); client reads `LANGFUSE_HOST` + public/secret keys.
- **`src/__tests__/langfuse-dispatch.spec.ts` (NEW, §9 NET-NEW).** The §7 risk-row oracle: keys absent → `null`; keys present + dead port (`127.0.0.1:1`) → the full adapter call sequence (span → generation → tool spans → event → score → end → flush/shutdown) **never throws**, tolerates malformed/empty inputs, and `shutdownSafely(200)` resolves bounded. In the default suite.
- **`test/e2e/` (NEW).** Live read-back proof (the only way to verify the wire). `readback.ts` (read-only client + `pollTrace`/`byName`/`ofType`, honors §7 by using a separate client); `bunfig.toml` disables the root preload so the tier drives the **real** `PiRuntimeAdapter` (root `mocks.ts` would stub the seam). Two gated tiers + `test:e2e`/`test:e2e:llm` scripts:
  - **Tier 1 — `langfuse-mocked-agent.e2e.spec.ts`** (`LANGFUSE_E2E=1`, deterministic, no LLM): mock pi `Agent` emits a fixed event sequence through the real adapter + real tracer → live Langfuse, then reads the trace back and asserts phase span, nested tool span, a **generation with tokens AND cost**, and verifier rubric → scores.
  - **Tier 2 — `langfuse-llm-smoke.e2e.spec.ts`** (`LANGFUSE_E2E_LLM=1`, billable, manual): real agent → real provider → live trace with a non-zero real per-call cost. Loose asserts (≥1 generation, cost>0).

**Validation:** typecheck ✅ · full suite **48 unit + 9 standalone, 0 fail** (process-isolated runner) ✅ · `langfuse-dispatch` no-op oracle ✅ · **Tier 1 e2e ran LIVE** against the running `podman-compose` Langfuse → **1 pass / 0 fail** (6.7s): read-back confirmed `phase:verify` span + `tool:bash` span + generation(tokens+cost) + `verifier:*` scores — the genuine §4 2.1 acceptance, on a real server. Tier 2 (real LLM) is gated/billable → not run (manual only). Branch `docs/migrate-langgraph-langfuse-rfc` — **not yet committed**.

**Deviations / decisions made during implementation:**

1. **e2e specs live outside `src` → outside `tsc`.** `tsconfig.json` `include` is `["src"]` and excludes `src/__tests__`, so neither unit nor e2e specs are typechecked — consistent with the project stance that specs are validated by **running**, not by `tsc`. Tier 1 is validated by its live green run; widening `include` would force typechecking the deliberately-loose mock shapes (`any` pi events) and was left out of scope.
2. **`test/e2e/bunfig.toml` disables the root preload.** The root `bunfig` preloads `mocks.ts`, which stubs `spawnAgent` — that would short-circuit the very seam the e2e tier exists to validate. The tier must inherit no mocks.
3. **`generation` on `turn_end` only; domain `event()` exposed but not yet wired.** `agent_start/end` map to span open/close; pi `turn_start` carries no usage so only `turn_end` becomes a generation. `AgentSpan.event()` exists for §4's "domain events → `event()`" but the adapter still routes domain/tool events through the JSONL appender (dual observability) — no acceptance criterion rides on span-side `event()`, so it's deferred to avoid duplicate emission before the 2.2 cutover.

**Gotchas for the next session:**

- **Run tests with `bun run test` (= `bun src/dev/run-tests.ts`, process-isolated, concurrency 8). This is the green, authoritative command.** A naive `bun test src/__tests__/` loads all specs into **one** process and Bun's process-global `mock.module()` leaks across files → **43 false failures** (was 38 pre-1.3; grew because 1.3 added `node-projection.spec` + converted `langgraph-parity.spec` + trimmed `events-appender.spec`, all of which register top-level mocks). Every spec passes in isolation; the isolated runner is **0 fail / 48 specs** (2.1 added `langfuse-dispatch.spec`). The 43 are leak victims (`createTask`, pipeline phase cases, …), not real regressions. _(If naive-`bun test` parity is ever wanted, add `mock.restore()` in an `afterAll` to the specs that `mock.module(...)` at top level — deferred; not blocking.)_
- `better-sqlite3` does **not** load under Bun — the engine's checkpointer is the hand-rolled `BunSqliteSaver`.
- The control path must **never read back from Langfuse** (§1 constraint 1, §7): the retrospective reads local `runs.jsonl` only.
- **Uncommitted:** all of Phase 1 (1.1 → 1.3) **and Phase 2.1** are on branch `docs/migrate-langgraph-langfuse-rfc`, **not yet committed**. Suggested commit boundaries: Phase 1.3 as two logical commits (1: ⚠ BREAKING flip+delete+test-triage · 2: node-direct projections + `node-projection.spec`); Phase 2.1 as one additive commit. **Full Phase 2.1 file set:** `src/tracing/langfuse.ts` (NEW), `src/agent/adapters/pi-adapter.ts`, `src/pipeline.ts`, `src/types.ts`, `src/phases/{scout,verify,review,close,retrospective}.ts`, `src/__tests__/langfuse-dispatch.spec.ts` (NEW), `test/e2e/` (NEW), `.env.example` (NEW), `.gitignore`, `package.json`, `bun.lock`. **⚠ Exclude `PROMPT.md`** (untracked, unrelated scratch — not part of the migration). Commit before starting 2.2 for a clean bisect.
- **e2e needs the live stack:** Tier 1 (`bun run test:e2e`, `LANGFUSE_E2E=1`) requires `podman-compose -f podman-compose.yaml up -d` and the seeded keys exported (the script runs `--cwd test/e2e`, so the root `.env` is **not** auto-loaded — export `LANGFUSE_HOST`/`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` inline). Default `bun run test` excludes `test/e2e` entirely.

### ✅ Phase 2.2 — ⚠ BREAKING: delete the granular event log, cut over to Langfuse-only observability — **DONE**

The JSONL event log + its schema/appender/reducer are gone. Langfuse is now the **sole** trace sink; orchestration state lives in an in-memory container; `ca watch` reads the Langfuse trace. Full suite green (46 unit + 9 standalone, 0 fail).

**Landed:**

- **`src/state/run-state.ts` (NEW).** `RunState` — a JSONL-free in-memory container holding the **unchanged** `PipelineState` shape, with typed mutators (`startPhase`/`endPhase`/`setStatus`/`requestRevision`/`end`/`seedRevision`) ported from the reducer's per-case bodies. Replaces the `EventAppender` + `reduceEvents` pair: Phase 1.3 had the engine _drive_ `PipelineState` via granular events and _read it back_ via `appender.getState()`, so deleting the log meant **replacing the live state container**, not just removing a sink. Because the shape is identical, `projectTaskJson`/`projectMarkers`/`projectMetrics` (kept in `events/projections.ts`) are byte-identical by construction.
- **Deleted:** `src/events/{schema,appender,reducer,errors}.ts`. **Kept** `src/events/{types,projections,plan}.ts` (state shape, projections, plan generation — no event-log dependency).
- **`src/langgraph/engine.ts` + `src/pipeline.ts` + `src/pipeline-dispatch.ts`.** `appender` → `runState` throughout; `append({event})` calls became `runState.*` mutators. Orchestration-level domain events (`revision_requested` / `revision_budget_exhausted` / `fingerprint_match` / `scout_completed`) now land on the trace via a new **trace-level `LangfuseTracer.event()`** (closes 2.1 deviation 3 — they have no agent span). `config.eventAppender` → `config.runState` on `PipelineConfig`.
- **`src/agent/adapters/pi-adapter.ts`.** Deleted the dead `tool_start`/`tool_end` → `eventAppender`/`traceWriter` JSONL branches; `span.toolStart/toolEnd` (Langfuse, unconditional) + `onToolActivity` (TUI) already cover tools. `eventAppender`/`traceWriter` dropped from `SpawnAgentOptions` and the 6 phase pass-throughs.
- **`src/state/transitions.ts`.** Dropped the dead `determineEntryPhase(PipelineState)` overload (only the `TaskJson` form has a prod caller).
- **`ca watch` → Langfuse (RFC §5 decision 3, revised).** `src/tracing/readback.ts` (NEW, promoted from `test/e2e/readback.ts`; e2e re-exports it) is a read-only client honoring §7. `src/watch/watcher.ts` now **loads the run's trace observations then polls-with-cursor** for new ones (Langfuse has no push API — same as the dashboard), yielding normalized `WatchRecord`s; `renderer.ts` renders them; `commands/watch.ts` errors clearly when keys are absent (`--run <id>` pins a run).

**Test triage (§9):** DIE (deleted) — `events-appender.spec`, `events-reducer.spec`, `events-validation.spec`. PORT — `events-reducer.spec` behavior → **`run-state.spec` (NEW)** (state-build oracle over `RunState`). Re-pointed — `checkpointer-resume.spec` (dropped the `reduceEvents` oracle for the directly-known crash-point expectation; `appender` stub → `runState` stub). Rewritten — `watch-watcher.spec` + `watch-renderer.spec` (Langfuse `WatchRecord` API, fake read client). Unchanged — `events-projections.spec`, `node-projection.spec` (projections + state shape survive).

**Validation:** typecheck ✅ · `oxlint` 0 errors (2 pre-existing warnings on `interview/session.ts:40`) ✅ · `oxfmt` (my files) ✅ · full suite **46 unit + 9 standalone, 0 fail** (process-isolated runner) ✅.

**Deviations / decisions made during implementation:**

1. **State container replaces appender/reducer (not a pure deletion).** The plan called `projectTaskJson`/`projectMarkers` "orphaned" — stale relative to post-1.3 code, where `projectNodeState` uses them at runtime. The faithful 2.2 keeps the projections + `PipelineState` shape and swaps only the _driver_ (events → `RunState` mutators). `reduceEvents`/`loadEventsFromFile`/`validateTransition`/the event schema are gone; the transition logic survives as plain methods.
2. **`ca watch` re-pointed to Langfuse, not an "in-process callback stream" (§5 decision 3 revised).** That decision predated the realization that `ca watch` is a _separate process_ — there is no shared in-process stream cross-process. Per user direction, watch now loads + polls the Langfuse trace (full fidelity: tool spans, generations w/ tokens+cost, scores), reusing the 2.1 read-back client. Trade-off accepted: watch now **requires Langfuse keys + reachability** (no offline tail) and sees events at ingest latency (seconds). Reading Langfuse from a _human tool_ does not violate §7 (that bars the _control path_).
3. **Domain `event()` is trace-level, not span-level (closes 2.1 deviation 3).** Orchestration events fire between phases (no agent span), so they attach to the run trace via `LangfuseTracer.event()`; per-call generations/tool spans stay span-nested as before. No more dual emission — the JSONL sink it would have duplicated is gone.
4. **`scout_completed`/`status_changed` are no longer state mutations.** They only bumped `lastSequence` in the reducer (observability-only); `scout_completed` is now a trace event, `status_changed` is folded into `RunState.setStatus`. Net td/metrics state unchanged.

**End state:** the migration is complete. `runs.jsonl`, working memory, marker files, and td are the durable local truth (unchanged); LangGraph + the SQLite checkpointer own orchestration + resume; Langfuse holds the audit trace and drives `ca watch`. Breaking surface of 2.2 = any external consumer of `run-*.jsonl` and `ca watch`'s old JSONL source.

---

## 1. Motivation

Case currently owns ~5,400 LOC across three subsystems:

- **Custom DAG** (`src/dag/`, `src/pipeline.ts`) — graph build, ready-node dispatch, revision loops, outcome routing.
- **Event-sourcing** (`src/events/`) — granular JSONL log that is replayed for crash-resume AND doubles as the observability/metrics source.
- **Agent runtime** (`src/agent/`) — pi-agent-core wrapper.

Two of those subsystems substantially re-implement what LangGraph and Langfuse provide natively:

- LangGraph gives `StateGraph` (conditional edges, cycles, parallel supersteps) and a **checkpointer** that subsumes our replay-for-resume path.
- Langfuse models the exact trace → span → event → score tree our event taxonomy already encodes, plus token/cost (which pi pre-computes per call but we never surface).

The agent runtime (pi) **stays** — LangGraph nodes wrap `agent.execute()`. This is not a rewrite of how agents run; it is a replacement of how they are _sequenced_ and _observed_.

### Expected net effect

- **Delete** the custom executor/builder and the granular event schema/appender/reducer (~1,800 LOC of the ~5,400).
- **Add** LangGraph graph wiring + Langfuse dispatch glue (~300–500 LOC).
- **Net ≈ −700 to −1,000 LOC**, plus we stop maintaining a graph runner and a trace exporter.
- **Gain** a trace UI, first-class eval scores, and per-call token + dollar cost — none of which exist today.

### Guiding constraints

1. **Nothing in the control path may read back from Langfuse.** Langfuse is async, batched-over-HTTP, lossy-on-crash, and retention-bounded. It is a fire-and-forget sink only.
2. **The self-improvement loop stays local and durable.** The retrospective phase reads a small local run-summary (`runs.jsonl`), never Langfuse.
3. **The live TUI feed stays in-process.** The terminal activity feed is driven by synchronous callbacks, not by the trace sink — Langfuse cannot drive a live local UI.
4. **Evidence gates stay truth-on-disk.** Marker files (`tested`, `reviewed`) remain the gate truth; they are not derived from a remote store.

### Deployment

Langfuse is self-hosted via `podman-compose` (see `podman-compose.yaml`). The dispatch target is **configurable** — `LANGFUSE_HOST` / `LANGFUSE_BASE_URL` (plus public/secret keys) default to the compose service but may point at any Langfuse instance (incl. cloud). Self-hosting means retention is an operator knob, not a fixed vendor limit — but the §7 "control path never reads Langfuse" rule holds regardless.

---

## 2. Feature Inventory (parity table)

Every current feature, its present implementation, and where it lands after migration. Disposition tags:

- **KEEP** — unchanged, no migration work.
- **MOVE** — same behavior, relocated to LangGraph/Langfuse primitive.
- **REPLACE** — re-expressed against a framework primitive (logic preserved, mechanism changes).
- **UPGRADE** — gains capability we don't have today.
- **NEW** — net-new capability the migration unlocks.

### Orchestration / DAG

| Name                                                                    | Current implementation                                                                                 | New implementation                                                                              | Disposition                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Graph construction (profiles: tiny/standard)                            | `buildGraph(profile, maxRevisionCycles)` — `src/dag/builder.ts:5`; `PROFILE_PHASES` `src/types.ts:119` | `StateGraph` definition; profile selects which nodes/edges are added                            | REPLACE                                                                                                                 |
| Ready-node detection + parallel dispatch                                | `findReadyNodes()` + `Promise.all` — `src/dag/executor.ts:64,177`                                      | LangGraph native parallel supersteps (fan-out edges)                                            | REPLACE — _parallel dispatch exists today; tiny/standard profiles are near-linear and exercise it only as graphs widen_ |
| Conditional revision loops (implement→verify→review→implement N+1)      | Edge predicates `revisionRequestedPredicate()` — `src/dag/builder.ts:89,140-178`                       | LangGraph conditional edges returning next node                                                 | REPLACE                                                                                                                 |
| Revision budget cap                                                     | `maxRevisionCycles` (default 2) — `src/pipeline.ts:106`                                                | Counter channel in graph state + conditional-edge guard; LangGraph `recursionLimit` as backstop | REPLACE                                                                                                                 |
| Fingerprint loop detection (SHA-256 of failure reason; abort on repeat) | `handleEvaluatorPairCompletion()` — `src/dag/executor.ts:220-269`                                      | Same logic as a node/edge function over graph state (preserved verbatim, relocated)             | MOVE                                                                                                                    |
| Outcome matrix `(phase, outcome) → action`                              | `src/dag/outcome-table.ts`                                                                             | Conditional-edge routing functions keyed off the same table                                     | REPLACE                                                                                                                 |
| Failure routing → skip pending, run retrospective once                  | `src/dag/executor.ts:112`                                                                              | Conditional edge to `retrospective` node; other pending nodes unreachable                       | REPLACE                                                                                                                 |
| Human override (retry/abort prompt, attended mode)                      | `src/pipeline.ts:303-313`                                                                              | LangGraph `interrupt` (human-in-the-loop) or retain custom prompt around graph step             | REPLACE — **decision needed** (see §5)                                                                                  |
| Scout non-blocking routing                                              | Always routes `implement_0` — `src/pipeline.ts:289-293`                                                | Unconditional edge scout→implement                                                              | REPLACE                                                                                                                 |
| Cross-phase state passing (`scoutSlot`, `previousResults`, `revision`)  | Closures + `Map<AgentName, AgentResult>` — `src/pipeline.ts:82,165,297`                                | LangGraph state channels (typed `StateGraph` state object)                                      | MOVE                                                                                                                    |

### Resume / state

| Name                                              | Current implementation                                                                                                         | New implementation                                                            | Disposition |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------- |
| Crash recovery / mid-graph resume                 | Replay log: `loadEventsFromFile` → `reduceEvents` → `restoreGraphState` — `src/pipeline.ts:119-127`, `src/dag/restore.ts:4-18` | LangGraph checkpointer (SQLite) auto-restores last superstep                  | REPLACE     |
| Resume from pending revision                      | `task.pendingRevision` seeded from td — `src/pipeline.ts:139-148`                                                              | `pendingRevision` lives in checkpointed graph state; td still seeds first run | MOVE        |
| Pipeline state model                              | Event-sourced `PipelineState` via `reduceEvents` — `src/events/reducer.ts`                                                     | LangGraph state channels; checkpointer snapshots replace event replay         | REPLACE     |
| Task state persistence (authoritative `TaskJson`) | Hidden `<!-- case-state -->` JSON in td issue description — `src/state/td-client.ts`, `src/state/task-store.ts`                | **Unchanged** — td remains the task-grain store                               | KEEP        |
| Working memory (per-agent context between phases) | `working-memory.json` r/w — `src/memory/working-memory.ts:32-96`; `ca update-memory`                                           | **Unchanged** — local JSON, not event-derived                                 | KEEP        |

### Observability

| Name                                           | Current implementation                                                                            | New implementation                                                                       | Disposition                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| Granular event log (phase/tool/domain events)  | JSONL `run-*.jsonl` — `src/events/appender.ts:48`, schema `src/events/schema.ts`                  | Langfuse dispatch at the subscriber seam (trace/span/event); **log deleted**             | MOVE → Langfuse                        |
| Tool activity tracing (sanitized args/results) | `tool_execution_start/end` → event + `onToolActivity` — `src/agent/adapters/pi-adapter.ts:79-126` | Langfuse nested spans (via same subscriber)                                              | MOVE → Langfuse                        |
| LLM-call telemetry (tokens)                    | Cumulative only: `ctx.getContextUsage().tokens` — `src/agent/orchestrator-session.ts:246`         | Langfuse **generation** spans from `turn_end.message.usage` (per call)                   | UPGRADE                                |
| LLM-call **cost** ($)                          | Not tracked                                                                                       | Langfuse generation `usage.cost` — pi pre-computes per call (`pi-ai types.d.ts:144-157`) | NEW                                    |
| Eval rubric scores (verifier/reviewer)         | Embedded in `AgentResult` / metrics                                                               | Langfuse **score()** — first-class eval dashboards                                       | UPGRADE                                |
| Phase metrics (duration, status, artifacts)    | `projectMetrics()` — `src/events/projections.ts:61`                                               | Langfuse spans + retained run-summary                                                    | MOVE → Langfuse                        |
| Run summary log (`runs.jsonl`)                 | `writeRunMetrics()` — `src/metrics/writer.ts:12`                                                  | **Kept local** — retrospective's durable read source                                     | KEEP                                   |
| Prior-run linking (`priorRunId`)               | `findPriorRunId()` reads `runs.jsonl` — `src/versioning/prompt-tracker.ts:56-82`                  | **Unchanged** — reads kept `runs.jsonl`                                                  | KEEP                                   |
| Live TUI activity feed / heartbeat (10s)       | `onToolActivity` / `onAgentHeartbeat` callbacks → notifier — `src/agent/adapters/pi-adapter.ts`   | **Unchanged** — synchronous in-process callbacks (Langfuse cannot drive live local UI)   | KEEP                                   |
| Live event tail (`ca watch`)                   | Polls JSONL — `src/watch/watcher.ts:26-77`                                                        | Langfuse trace UI (remote) **or** re-point `ca watch` at in-process callback stream      | REPLACE — **decision needed** (see §5) |

### Evidence / task mirror

| Name                                                       | Current implementation                                                                                           | New implementation                                                                      | Disposition                             |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------- |
| Evidence markers (`tested` / `reviewed` / `manual-tested`) | Disk files written via `projectMarkers()` — `src/events/appender.ts:76-84`; `ca mark-*`                          | Node writes marker file **directly** on phase completion; checkpointer holds marker set | MOVE (drop event hop; disk stays truth) |
| td status mirror (native status + labels)                  | `projectTaskJson()` after each event — `src/events/appender.ts:72`; `caseToTdStatus` `src/state/td-client.ts:76` | Node writes td **directly** on phase end (already a synchronous projection)             | MOVE (drop event hop)                   |
| td CRUD / focus / resolveFocusedTask                       | `src/state/td-client.ts`                                                                                         | **Unchanged**                                                                           | KEEP                                    |

### Agent runtime

| Name                                       | Current implementation                                                                   | New implementation                              | Disposition |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------- |
| Per-phase agent execution                  | `PiRuntimeAdapter.spawn` → `agent.execute()` — `src/agent/adapters/pi-adapter.ts:29-186` | **Unchanged** — wrapped as a LangGraph node     | KEEP        |
| Per-agent tool sets (mutable vs read-only) | `createPiTools()` per agent                                                              | **Unchanged**                                   | KEEP        |
| System-prompt loading per agent            | Loaded from `agents/*.md`                                                                | **Unchanged**                                   | KEEP        |
| Model resolution + override                | `ModelRegistry` + `CASE_MODEL_OVERRIDE`                                                  | **Unchanged**                                   | KEEP        |
| Per-phase timeout (600s default)           | pi-adapter timeout                                                                       | **Unchanged** (or LangGraph node timeout)       | KEEP        |
| Result parsing → `AgentResult`             | `parseAgentResult()`                                                                     | **Unchanged**                                   | KEEP        |
| Runtime pluggability interface             | `CaseAgentRuntime` — `src/agent/runtime.ts`                                              | **Unchanged** — LangGraph node calls through it | KEEP        |

### Self-improvement

| Name                | Current implementation                                                                            | New implementation                                                          | Disposition |
| ------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------- |
| Retrospective phase | Reads in-memory `metricsSnapshot` + `previousResults` — `src/phases/retrospective.ts:24-26,57-76` | **Unchanged** logic; snapshot computed from graph state / kept `runs.jsonl` | KEEP        |
| Prompt versioning   | `promptVersions` in metrics — `src/versioning/`                                                   | **Unchanged**                                                               | KEEP        |

---

## 3. Target Architecture

```
Run = Langfuse trace (keyed runId)
│
├─ LangGraph StateGraph                          ← orchestration
│    nodes  = phases (scout, implement, verify, review, close, retrospective)
│    node body wraps pi agent.execute()          ← KEEP pi runtime
│    edges  = conditional routing (outcome matrix, revision loop, fingerprint guard)
│    state  = typed channels (results, pendingRevision, revisionCycles, markers)
│    checkpointer = SQLite in <repo>/.todos/      ← REPLACES replay-for-resume
│
├─ pi agent.subscribe(event)   [pi-adapter.ts:68, exists]   ← single observability seam
│    agent_start/end          → Langfuse span (phase)
│    turn_start/turn_end       → Langfuse generation (usage = tokens + cost)
│    tool_execution_start/end  → Langfuse span (nested)
│    domain events             → Langfuse event()
│    rubric                    → Langfuse score()
│    AND (unchanged) → onToolActivity/onAgentHeartbeat → live TUI notifier
│
├─ runs.jsonl  (local, kept)                     ← retrospective read source
├─ working-memory.json (local, kept)             ← cross-phase agent context
├─ marker files (local, kept)                    ← evidence gates
└─ td issue (kept)                               ← task-grain state + human mirror
```

Three homes, zero overlap:

- **Orchestration state** (node status, revisionCycles, pendingRevision) → LangGraph checkpointer.
- **Non-orchestration events** (tool traces, phase timing, scout findings, rubrics, diagnostics) → Langfuse.
- **Durable local truth** (run summary, working memory, markers, task state) → unchanged files / td.

---

## 4. Migration Plan (two phases, one breaking change each)

Two phases, severable because the event log's two roles (resume source, observability source) die in different phases. **Phase 1** swaps orchestration to LangGraph and severs the resume role; the log survives **write-only** as the observability source. **Phase 2** adds Langfuse, then severs the observability role and deletes the log. Each phase is a sequence of additive/flagged/reversible steps followed by **exactly one labeled breaking cutover** — so a bisect localizes any regression to one phase, and the breaking commit in each phase is singular.

Invariant across the whole migration until `2.2`: the granular `run-*.jsonl` keeps being **written** (the appender is untouched). Phase 1 only stops _reading_ it for resume; Phase 2 stops writing it.

### Phase 1 — Orchestration → LangGraph

No observability change. Event log still written (now only the metrics/observability source). Langfuse absent. `ca watch` still polls JSONL.

**1.1 — Wrap pi as a LangGraph node (parallel path, no cutover).** _Additive · reversible._
Introduce `StateGraph` reproducing the current linear+revision flow; each node calls the existing `CaseAgentRuntime`. Gate behind `CASE_ENGINE=langgraph`. Old executor remains default.
_Acceptance:_ a tiny-profile run completes through the LangGraph path with identical phase outcomes to the legacy executor.

**1.2 — Stand up the checkpointer; dual-write; prove resume parity.** _Additive · reversible._
Add the LangGraph SQLite checkpointer in `.todos/` (co-location per §6). Run both resume mechanisms; assert restored graph state matches `reduceEvents` on the same crash point.
_Acceptance:_ kill a run mid-`implement_1`; both paths resume to the same node set and `pendingRevision`.

**1.3 — ⚠ BREAKING: resume cutover + default flip.** _The one breaking change of Phase 1. Guarded by 1.2's parity test._
Flip the default to LangGraph and delete the legacy engine: remove `loadEventsFromFile` → `reduceEvents` → `restoreGraphState` and the old executor/builder. Relocate the td mirror + marker writes to **node-direct** (write on node completion; remove those projection side-effects from the event path — the raw appender stays, only its derived writes move). After this, resume is checkpointer-only and orchestration no longer touches the event log.
_Acceptance:_ resume works with the replay path gone; td status + labels and marker files still update each phase; `runs.jsonl`/metrics unchanged; full suite green.

_End state of Phase 1:_ LangGraph + checkpointer own orchestration; event log is a write-only observability sink; everything else (Langfuse, `ca watch`) unchanged.

### Phase 2 — Observability → Langfuse

No orchestration change. Begins additive; the single breaking cutover is the log deletion.

**2.1 — Add Langfuse dispatch at the subscriber seam.** _Additive · fire-and-forget · reversible._
In `pi-adapter.ts:68`, map `agent_start/end`, `turn_start/end`, `tool_execution_*`, domain events, and rubrics to Langfuse trace/span/generation/event/score. Keep `onToolActivity`/heartbeat feeding the TUI. Langfuse failures must not affect the run. Observability is now **dual** (JSONL + Langfuse).
_Acceptance:_ a run produces a complete Langfuse trace with per-call token + cost; with Langfuse unreachable, the run still completes and the TUI feed is intact.

**2.2 — ⚠ BREAKING: delete granular event log + re-point `ca watch`.** _The one breaking change of Phase 2._
Delete `src/events/{schema,appender,reducer}.ts` and the now-orphaned `projectTaskJson`/`projectMarkers`. Re-point `ca watch` from JSONL polling to the in-process callback stream (per §5 decision 3). **Keep** `runs.jsonl`, `findPriorRunId`, working memory, markers, td.
_Acceptance:_ full suite green; `ca watch` tails live activity; retrospective still reads `runs.jsonl`; Langfuse trace complete. Breaking surface = any external consumer of `run-*.jsonl` and `ca watch`'s source.

---

## 5. Decisions (resolved)

1. **Resume mechanism — DECIDED: LangGraph SQLite checkpointer.** Not td-embedded graph state (td stays a coarse human-facing projection — it lacks per-cycle keys, `revisionCycles`, the fingerprint set, and full `AgentResult` bodies), and not a hand-rolled snapshot. The checkpointer owns engine state; td keeps mirroring coarse status for humans. Co-location with td's SQLite must be verified (§6).
2. **Human override mechanism — DECIDED: LangGraph `interrupt`.** Native human-in-the-loop; composes with checkpointed resume. (Alt considered: custom retry/abort prompt wrapped around graph steps.)
3. **`ca watch` future — DECIDED: re-point at the in-process callback stream. → REVISED at 2.2: load + poll the Langfuse trace.** The callback-stream plan assumed a shared in-process channel, but `ca watch` is a _separate process_ — nothing in-process is shared cross-process. 2.2 instead has watch load the run's Langfuse observations then poll-with-cursor (full fidelity, reuses the 2.1 read-back client). Trade-off: watch now requires Langfuse (no offline tail) + ingest latency; reading Langfuse from a human tool does not breach §7. See §0 Phase 2.2 deviation 2. (Alts considered: in-process callback tee — impossible cross-process; a minimal activity-log file — rejected, resurrects the JSONL we deleted.)
4. **Revision budget mechanism — DECIDED: custom counter channel + edge guard.** Explicit, matches today's `maxRevisionCycles`. LangGraph `recursionLimit` retained only as a runaway backstop. (Alt considered: `recursionLimit` alone — too blunt.)

---

## 6. Open Verifies (must confirm during Phase 1)

- **Checkpointer / td SQLite co-location. — RESOLVED (1.2): sibling DB.** td owns `<repo>/.todos/issues.db` and runs 29 versioned migrations with no namespace isolation, so co-locating checkpoint tables there risks a future td migration dropping them. The checkpointer lives in the sibling `<repo>/.todos/case-checkpoints.db` instead (the fallback this bullet anticipated). See §0 Phase 1.2 deviation 1.
- **Outcome-matrix → conditional-edge re-expression.** Confirm every `(phase, outcome) → action` row maps to a deterministic edge function with no loss (esp. `abort`, `request-revision`, fingerprint short-circuit).
- **pi LLM-call seam.** Confirmed available: `turn_end` carries `message.usage` with tokens **and** pre-computed `cost` (`pi-ai types.d.ts:144-157`); subscriber already exists at `pi-adapter.ts:68`. No pi patching required.

---

## 7. Risks

| Risk                                                     | Impact                                                              | Mitigation                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Event-sourcing → snapshot semantics shift                | Lose "replay full event stream to derive new metrics retroactively" | Langfuse holds the audit trace; retro metrics derived live and persisted to `runs.jsonl` |
| Langfuse retention evicts history the control path needs | Self-improvement loop breaks                                        | Hard rule: control path never reads Langfuse; retro reads local `runs.jsonl`             |
| Langfuse outage during a run                             | Lost observability for that run                                     | Fire-and-forget dispatch; run + TUI unaffected (checkpointer + callbacks are local)      |
| LangGraph edge re-expression drifts from outcome matrix  | Subtle routing bugs                                                 | Phase 1.1/1.2 parity test vs. legacy executor on identical inputs before the 1.3 cutover |
| Marker / td drift after dropping event projection        | Gates or status out of sync                                         | Phase 1.3 writes them node-direct (same synchronous point as today) + suite assertions   |

---

## 8. Out of Scope

- Replacing pi-agent-core with LangChain's agent/tool layer (separate, larger decision).
- Replacing td as the task-grain store.
- Changing agent prompts, tool sets, or model selection.

---

## 9. Test Disposition

The phases delete whole subsystems, so their tests must be triaged — not blanket-deleted. Three buckets: **DIE** (mechanism gone, behavior gone), **PORT** (behavior survives, mechanism swaps — deleting silently drops a guarantee), **KEEP** (relocated-verbatim or out of scope).

### DIE — remove with the code

| Test                     | Deleted dependency                                                      | When |
| ------------------------ | ----------------------------------------------------------------------- | ---- |
| `dag-builder.spec`       | `dag/builder buildGraph` (→ `StateGraph` def)                           | 1.3  |
| `dag-builder-scout.spec` | `dag/builder`                                                           | 1.3  |
| `dag-executor.spec`      | `dag/executor executeGraph,findReadyNodes` (→ LangGraph runs the graph) | 1.3  |
| `events-appender.spec`   | `events/appender`                                                       | 2.2  |
| `events-reducer.spec`    | `events/reducer reduceEvents,loadEventsFromFile`                        | 2.2  |
| `events-validation.spec` | `events/errors validateTransition` (no event lifecycle)                 | 2.2  |

> ⚠ `events-reducer.spec` is the **resume-correctness oracle**. Its assertions are the parity target the checkpointer must match in 1.2. Retire only after 1.3 cutover is green — do not delete in step order ahead of its replacement.

### PORT — behavior survives, must stay tested

| Test                                 | Behavior preserved                                                                        | Re-point to                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `events-projections.spec`            | `projectTaskJson` status mapping; **`projectMarkers` (evidence gates)**; `projectMetrics` | node-direct td-write + marker-write (1.3); metrics → `runs.jsonl`/Langfuse |
| `dag-status.spec`                    | `projectStatusFromGraph` (node states → `TaskStatus`)                                     | same logic over LangGraph state channels (1.3)                             |
| resume assertions in `pipeline.spec` | crash → correct node set + `pendingRevision`                                              | checkpointer restore (1.2)                                                 |

> ⚠ `projectMarkers` coverage must exist node-direct after 1.3 — markers are the evidence gates (§1 constraint 4). Losing this test silently weakens a gate.

### KEEP — relocated-verbatim or out of scope

- `fingerprint.spec` — `dag/fingerprint` is MOVE-verbatim (§2).
- `outcome-table.spec` — table retained; conditional edges key off it.
- `dag-merge.spec` — `mergeRevisionRequests` is pure on `RevisionRequest[]`, no graph dependency.
- All non-orchestration suites (onboard, interview, scout, sanitize, parse-agent-result, config, paths, …).

### AUDIT — mixed, split don't blanket-delete

- `pipeline.spec` — replay-resume parts DIE; phase-sequence/outcome parts PORT. Read and split.
- `orchestrator-session.spec` — token telemetry is cumulative today, UPGRADE'd to per-call Langfuse (§2). The cumulative-tokens assertion changes meaning; re-check rather than assume.

### NET-NEW — coverage the phases require

Deleting the DIE bucket leaves holes. Add:

- **1.2:** checkpointer resume parity (the new oracle replacing `events-reducer.spec`).
- **1.3:** LangGraph graph-construction + conditional-edge routing (replaces builder/executor tests; routing still keys off `outcome-table`).
- **2.1:** Langfuse dispatch is fire-and-forget — assert _run completes + TUI feed intact with Langfuse unreachable_ (§7 risk row).
