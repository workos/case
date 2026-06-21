# Migration: Custom DAG + Event-Sourcing → LangGraph + Langfuse

**Status:** Proposed (RFC)
**Author:** Case maintainers
**Scope:** Replace Case's hand-rolled orchestration engine and granular event log with LangGraph (graph execution + checkpointing) and Langfuse (observability dispatch), without losing any existing feature.

---

## 1. Motivation

Case currently owns ~5,400 LOC across three subsystems:

- **Custom DAG** (`src/dag/`, `src/pipeline.ts`) — graph build, ready-node dispatch, revision loops, outcome routing.
- **Event-sourcing** (`src/events/`) — granular JSONL log that is replayed for crash-resume AND doubles as the observability/metrics source.
- **Agent runtime** (`src/agent/`) — pi-agent-core wrapper.

Two of those subsystems substantially re-implement what LangGraph and Langfuse provide natively:

- LangGraph gives `StateGraph` (conditional edges, cycles, parallel supersteps) and a **checkpointer** that subsumes our replay-for-resume path.
- Langfuse models the exact trace → span → event → score tree our event taxonomy already encodes, plus token/cost (which pi pre-computes per call but we never surface).

The agent runtime (pi) **stays** — LangGraph nodes wrap `agent.execute()`. This is not a rewrite of how agents run; it is a replacement of how they are *sequenced* and *observed*.

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

| Name | Current implementation | New implementation | Disposition |
|---|---|---|---|
| Graph construction (profiles: tiny/standard) | `buildGraph(profile, maxRevisionCycles)` — `src/dag/builder.ts:5`; `PROFILE_PHASES` `src/types.ts:119` | `StateGraph` definition; profile selects which nodes/edges are added | REPLACE |
| Ready-node detection + parallel dispatch | `findReadyNodes()` + `Promise.all` — `src/dag/executor.ts:64,177` | LangGraph native parallel supersteps (fan-out edges) | REPLACE — *parallel dispatch exists today; tiny/standard profiles are near-linear and exercise it only as graphs widen* |
| Conditional revision loops (implement→verify→review→implement N+1) | Edge predicates `revisionRequestedPredicate()` — `src/dag/builder.ts:89,140-178` | LangGraph conditional edges returning next node | REPLACE |
| Revision budget cap | `maxRevisionCycles` (default 2) — `src/pipeline.ts:106` | Counter channel in graph state + conditional-edge guard; LangGraph `recursionLimit` as backstop | REPLACE |
| Fingerprint loop detection (SHA-256 of failure reason; abort on repeat) | `handleEvaluatorPairCompletion()` — `src/dag/executor.ts:220-269` | Same logic as a node/edge function over graph state (preserved verbatim, relocated) | MOVE |
| Outcome matrix `(phase, outcome) → action` | `src/dag/outcome-table.ts` | Conditional-edge routing functions keyed off the same table | REPLACE |
| Failure routing → skip pending, run retrospective once | `src/dag/executor.ts:112` | Conditional edge to `retrospective` node; other pending nodes unreachable | REPLACE |
| Human override (retry/abort prompt, attended mode) | `src/pipeline.ts:303-313` | LangGraph `interrupt` (human-in-the-loop) or retain custom prompt around graph step | REPLACE — **decision needed** (see §5) |
| Scout non-blocking routing | Always routes `implement_0` — `src/pipeline.ts:289-293` | Unconditional edge scout→implement | REPLACE |
| Cross-phase state passing (`scoutSlot`, `previousResults`, `revision`) | Closures + `Map<AgentName, AgentResult>` — `src/pipeline.ts:82,165,297` | LangGraph state channels (typed `StateGraph` state object) | MOVE |

### Resume / state

| Name | Current implementation | New implementation | Disposition |
|---|---|---|---|
| Crash recovery / mid-graph resume | Replay log: `loadEventsFromFile` → `reduceEvents` → `restoreGraphState` — `src/pipeline.ts:119-127`, `src/dag/restore.ts:4-18` | LangGraph checkpointer (SQLite) auto-restores last superstep | REPLACE |
| Resume from pending revision | `task.pendingRevision` seeded from td — `src/pipeline.ts:139-148` | `pendingRevision` lives in checkpointed graph state; td still seeds first run | MOVE |
| Pipeline state model | Event-sourced `PipelineState` via `reduceEvents` — `src/events/reducer.ts` | LangGraph state channels; checkpointer snapshots replace event replay | REPLACE |
| Task state persistence (authoritative `TaskJson`) | Hidden `<!-- case-state -->` JSON in td issue description — `src/state/td-client.ts`, `src/state/task-store.ts` | **Unchanged** — td remains the task-grain store | KEEP |
| Working memory (per-agent context between phases) | `working-memory.json` r/w — `src/memory/working-memory.ts:32-96`; `ca update-memory` | **Unchanged** — local JSON, not event-derived | KEEP |

### Observability

| Name | Current implementation | New implementation | Disposition |
|---|---|---|---|
| Granular event log (phase/tool/domain events) | JSONL `run-*.jsonl` — `src/events/appender.ts:48`, schema `src/events/schema.ts` | Langfuse dispatch at the subscriber seam (trace/span/event); **log deleted** | MOVE → Langfuse |
| Tool activity tracing (sanitized args/results) | `tool_execution_start/end` → event + `onToolActivity` — `src/agent/adapters/pi-adapter.ts:79-126` | Langfuse nested spans (via same subscriber) | MOVE → Langfuse |
| LLM-call telemetry (tokens) | Cumulative only: `ctx.getContextUsage().tokens` — `src/agent/orchestrator-session.ts:246` | Langfuse **generation** spans from `turn_end.message.usage` (per call) | UPGRADE |
| LLM-call **cost** ($) | Not tracked | Langfuse generation `usage.cost` — pi pre-computes per call (`pi-ai types.d.ts:144-157`) | NEW |
| Eval rubric scores (verifier/reviewer) | Embedded in `AgentResult` / metrics | Langfuse **score()** — first-class eval dashboards | UPGRADE |
| Phase metrics (duration, status, artifacts) | `projectMetrics()` — `src/events/projections.ts:61` | Langfuse spans + retained run-summary | MOVE → Langfuse |
| Run summary log (`runs.jsonl`) | `writeRunMetrics()` — `src/metrics/writer.ts:12` | **Kept local** — retrospective's durable read source | KEEP |
| Prior-run linking (`priorRunId`) | `findPriorRunId()` reads `runs.jsonl` — `src/versioning/prompt-tracker.ts:56-82` | **Unchanged** — reads kept `runs.jsonl` | KEEP |
| Live TUI activity feed / heartbeat (10s) | `onToolActivity` / `onAgentHeartbeat` callbacks → notifier — `src/agent/adapters/pi-adapter.ts` | **Unchanged** — synchronous in-process callbacks (Langfuse cannot drive live local UI) | KEEP |
| Live event tail (`ca watch`) | Polls JSONL — `src/watch/watcher.ts:26-77` | Langfuse trace UI (remote) **or** re-point `ca watch` at in-process callback stream | REPLACE — **decision needed** (see §5) |

### Evidence / task mirror

| Name | Current implementation | New implementation | Disposition |
|---|---|---|---|
| Evidence markers (`tested` / `reviewed` / `manual-tested`) | Disk files written via `projectMarkers()` — `src/events/appender.ts:76-84`; `ca mark-*` | Node writes marker file **directly** on phase completion; checkpointer holds marker set | MOVE (drop event hop; disk stays truth) |
| td status mirror (native status + labels) | `projectTaskJson()` after each event — `src/events/appender.ts:72`; `caseToTdStatus` `src/state/td-client.ts:76` | Node writes td **directly** on phase end (already a synchronous projection) | MOVE (drop event hop) |
| td CRUD / focus / resolveFocusedTask | `src/state/td-client.ts` | **Unchanged** | KEEP |

### Agent runtime

| Name | Current implementation | New implementation | Disposition |
|---|---|---|---|
| Per-phase agent execution | `PiRuntimeAdapter.spawn` → `agent.execute()` — `src/agent/adapters/pi-adapter.ts:29-186` | **Unchanged** — wrapped as a LangGraph node | KEEP |
| Per-agent tool sets (mutable vs read-only) | `createPiTools()` per agent | **Unchanged** | KEEP |
| System-prompt loading per agent | Loaded from `agents/*.md` | **Unchanged** | KEEP |
| Model resolution + override | `ModelRegistry` + `CASE_MODEL_OVERRIDE` | **Unchanged** | KEEP |
| Per-phase timeout (600s default) | pi-adapter timeout | **Unchanged** (or LangGraph node timeout) | KEEP |
| Result parsing → `AgentResult` | `parseAgentResult()` | **Unchanged** | KEEP |
| Runtime pluggability interface | `CaseAgentRuntime` — `src/agent/runtime.ts` | **Unchanged** — LangGraph node calls through it | KEEP |

### Self-improvement

| Name | Current implementation | New implementation | Disposition |
|---|---|---|---|
| Retrospective phase | Reads in-memory `metricsSnapshot` + `previousResults` — `src/phases/retrospective.ts:24-26,57-76` | **Unchanged** logic; snapshot computed from graph state / kept `runs.jsonl` | KEEP |
| Prompt versioning | `promptVersions` in metrics — `src/versioning/` | **Unchanged** | KEEP |

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

Invariant across the whole migration until `2.2`: the granular `run-*.jsonl` keeps being **written** (the appender is untouched). Phase 1 only stops *reading* it for resume; Phase 2 stops writing it.

### Phase 1 — Orchestration → LangGraph

No observability change. Event log still written (now only the metrics/observability source). Langfuse absent. `ca watch` still polls JSONL.

**1.1 — Wrap pi as a LangGraph node (parallel path, no cutover).** *Additive · reversible.*
Introduce `StateGraph` reproducing the current linear+revision flow; each node calls the existing `CaseAgentRuntime`. Gate behind `CASE_ENGINE=langgraph`. Old executor remains default.
*Acceptance:* a tiny-profile run completes through the LangGraph path with identical phase outcomes to the legacy executor.

**1.2 — Stand up the checkpointer; dual-write; prove resume parity.** *Additive · reversible.*
Add the LangGraph SQLite checkpointer in `.todos/` (co-location per §6). Run both resume mechanisms; assert restored graph state matches `reduceEvents` on the same crash point.
*Acceptance:* kill a run mid-`implement_1`; both paths resume to the same node set and `pendingRevision`.

**1.3 — ⚠ BREAKING: resume cutover + default flip.** *The one breaking change of Phase 1. Guarded by 1.2's parity test.*
Flip the default to LangGraph and delete the legacy engine: remove `loadEventsFromFile` → `reduceEvents` → `restoreGraphState` and the old executor/builder. Relocate the td mirror + marker writes to **node-direct** (write on node completion; remove those projection side-effects from the event path — the raw appender stays, only its derived writes move). After this, resume is checkpointer-only and orchestration no longer touches the event log.
*Acceptance:* resume works with the replay path gone; td status + labels and marker files still update each phase; `runs.jsonl`/metrics unchanged; full suite green.

*End state of Phase 1:* LangGraph + checkpointer own orchestration; event log is a write-only observability sink; everything else (Langfuse, `ca watch`) unchanged.

### Phase 2 — Observability → Langfuse

No orchestration change. Begins additive; the single breaking cutover is the log deletion.

**2.1 — Add Langfuse dispatch at the subscriber seam.** *Additive · fire-and-forget · reversible.*
In `pi-adapter.ts:68`, map `agent_start/end`, `turn_start/end`, `tool_execution_*`, domain events, and rubrics to Langfuse trace/span/generation/event/score. Keep `onToolActivity`/heartbeat feeding the TUI. Langfuse failures must not affect the run. Observability is now **dual** (JSONL + Langfuse).
*Acceptance:* a run produces a complete Langfuse trace with per-call token + cost; with Langfuse unreachable, the run still completes and the TUI feed is intact.

**2.2 — ⚠ BREAKING: delete granular event log + re-point `ca watch`.** *The one breaking change of Phase 2.*
Delete `src/events/{schema,appender,reducer}.ts` and the now-orphaned `projectTaskJson`/`projectMarkers`. Re-point `ca watch` from JSONL polling to the in-process callback stream (per §5 decision 3). **Keep** `runs.jsonl`, `findPriorRunId`, working memory, markers, td.
*Acceptance:* full suite green; `ca watch` tails live activity; retrospective still reads `runs.jsonl`; Langfuse trace complete. Breaking surface = any external consumer of `run-*.jsonl` and `ca watch`'s source.

---

## 5. Decisions (resolved)

1. **Resume mechanism — DECIDED: LangGraph SQLite checkpointer.** Not td-embedded graph state (td stays a coarse human-facing projection — it lacks per-cycle keys, `revisionCycles`, the fingerprint set, and full `AgentResult` bodies), and not a hand-rolled snapshot. The checkpointer owns engine state; td keeps mirroring coarse status for humans. Co-location with td's SQLite must be verified (§6).
2. **Human override mechanism — DECIDED: LangGraph `interrupt`.** Native human-in-the-loop; composes with checkpointed resume. (Alt considered: custom retry/abort prompt wrapped around graph steps.)
3. **`ca watch` future — DECIDED: re-point at the in-process callback stream.** Keeps the offline local-first terminal tail; small adapter. (Alt considered: replace with the remote Langfuse trace UI — loses offline tail.)
4. **Revision budget mechanism — DECIDED: custom counter channel + edge guard.** Explicit, matches today's `maxRevisionCycles`. LangGraph `recursionLimit` retained only as a runaway backstop. (Alt considered: `recursionLimit` alone — too blunt.)

---

## 6. Open Verifies (must confirm during Phase 1)

- **Checkpointer / td SQLite co-location.** Now load-bearing (§5 decision 1 commits to the checkpointer). Confirm the LangGraph SQLite checkpointer can live in `<repo>/.todos/` alongside td's schema (separate tables, no migration conflict), or fall back to a sibling DB file (`<repo>/.todos/case-checkpoints.db`) if td guards its schema. Resolve in step 1.2.
- **Outcome-matrix → conditional-edge re-expression.** Confirm every `(phase, outcome) → action` row maps to a deterministic edge function with no loss (esp. `abort`, `request-revision`, fingerprint short-circuit).
- **pi LLM-call seam.** Confirmed available: `turn_end` carries `message.usage` with tokens **and** pre-computed `cost` (`pi-ai types.d.ts:144-157`); subscriber already exists at `pi-adapter.ts:68`. No pi patching required.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Event-sourcing → snapshot semantics shift | Lose "replay full event stream to derive new metrics retroactively" | Langfuse holds the audit trace; retro metrics derived live and persisted to `runs.jsonl` |
| Langfuse retention evicts history the control path needs | Self-improvement loop breaks | Hard rule: control path never reads Langfuse; retro reads local `runs.jsonl` |
| Langfuse outage during a run | Lost observability for that run | Fire-and-forget dispatch; run + TUI unaffected (checkpointer + callbacks are local) |
| LangGraph edge re-expression drifts from outcome matrix | Subtle routing bugs | Phase 1.1/1.2 parity test vs. legacy executor on identical inputs before the 1.3 cutover |
| Marker / td drift after dropping event projection | Gates or status out of sync | Phase 1.3 writes them node-direct (same synchronous point as today) + suite assertions |

---

## 8. Out of Scope

- Replacing pi-agent-core with LangChain's agent/tool layer (separate, larger decision).
- Replacing td as the task-grain store.
- Changing agent prompts, tool sets, or model selection.

---

## 9. Test Disposition

The phases delete whole subsystems, so their tests must be triaged — not blanket-deleted. Three buckets: **DIE** (mechanism gone, behavior gone), **PORT** (behavior survives, mechanism swaps — deleting silently drops a guarantee), **KEEP** (relocated-verbatim or out of scope).

### DIE — remove with the code

| Test | Deleted dependency | When |
|---|---|---|
| `dag-builder.spec` | `dag/builder buildGraph` (→ `StateGraph` def) | 1.3 |
| `dag-builder-scout.spec` | `dag/builder` | 1.3 |
| `dag-executor.spec` | `dag/executor executeGraph,findReadyNodes` (→ LangGraph runs the graph) | 1.3 |
| `events-appender.spec` | `events/appender` | 2.2 |
| `events-reducer.spec` | `events/reducer reduceEvents,loadEventsFromFile` | 2.2 |
| `events-validation.spec` | `events/errors validateTransition` (no event lifecycle) | 2.2 |

> ⚠ `events-reducer.spec` is the **resume-correctness oracle**. Its assertions are the parity target the checkpointer must match in 1.2. Retire only after 1.3 cutover is green — do not delete in step order ahead of its replacement.

### PORT — behavior survives, must stay tested

| Test | Behavior preserved | Re-point to |
|---|---|---|
| `events-projections.spec` | `projectTaskJson` status mapping; **`projectMarkers` (evidence gates)**; `projectMetrics` | node-direct td-write + marker-write (1.3); metrics → `runs.jsonl`/Langfuse |
| `dag-status.spec` | `projectStatusFromGraph` (node states → `TaskStatus`) | same logic over LangGraph state channels (1.3) |
| resume assertions in `pipeline.spec` | crash → correct node set + `pendingRevision` | checkpointer restore (1.2) |

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
- **2.1:** Langfuse dispatch is fire-and-forget — assert *run completes + TUI feed intact with Langfuse unreachable* (§7 risk row).
