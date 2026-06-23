# Pipeline & Agent Runtime (case itself)

How case runs a task end-to-end. This is the harness's own architecture — the
other docs in this folder describe **target** repos; this one describes `case`.

The split: **TypeScript decides which phase runs next; the LLM does the work
inside each phase.** Phase transitions are deterministic (a LangGraph
`StateGraph` plus the failure matrix); only the per-phase work is delegated to a
model.

## Entry

`runPipeline(config)` in [`src/pipeline.ts`](../../src/pipeline.ts) wires the
run: task store, renderer/notifier, in-memory `RunState`, a per-run
`LangfuseTracer`, and the default agent runtime (`ProviderRoutingRuntime`). It
then calls `executeLangGraph(...)`.

## Engine: LangGraph StateGraph

[`src/langgraph/engine.ts`](../../src/langgraph/engine.ts) builds a
`StateGraph` (`@langchain/langgraph`) over the phases:

```text
scout → implement → verify → review → close → retrospective
```

Phases present per run come from `PROFILE_PHASES[profile]` (`tiny` skips
verify; `standard`/`full` include it). Edges are conditional routers:

- `afterImplement` — failed → `retrospective`; else → `verify` (or `review` when
  no verify phase).
- `afterVerify` — failed → `retrospective`; rubric fail → `revise`; else
  → `review`.
- `afterReview` — failed → `retrospective`; rubric fail (and budget left)
  → `revise`; else → `close`.
- `revise` — decides `implement` (spend a cycle), `review`, or `close`.

`close → retrospective → END`. The retrospective never blocks: every failure
mode there is a non-fatal warning so the run can still report complete.

### Revision loop

Soft evaluator failures route back through `revise`:

- **Budget cap** — `maxRevisionCycles` (default 2). One implement node exists per
  cycle `0..maxRevisionCycles`; exceeding it closes with a surfaced warning.
- **Fingerprint short-circuit** — identical failure signature
  (`computeFingerprint` over failed categories + error summary, in
  [`src/dag/fingerprint.ts`](../../src/dag/fingerprint.ts)) two cycles running
  aborts the loop early instead of burning budget.
- **Reviewer hard gate** — a reviewer rubric fail on a `REVIEWER_HARD_CATEGORIES`
  category (`principle-compliance`, `scope-discipline`) is a terminal abort, not
  a revision. Verifier rubrics have no hard/soft split — any fail revises.

### Crash resume (checkpointer)

When a `BaseCheckpointSaver` is supplied
([`src/langgraph/checkpointer.ts`](../../src/langgraph/checkpointer.ts),
SQLite-backed) the graph compiles with it under a stable `threadId`. A
checkpoint with pending next-nodes = a genuinely interrupted run → resume from
saved state. On normal completion the thread is deleted so the next run starts
fresh. Without a checkpointer the run is in-memory only (no resume).

## Dispatch seam

The engine never spawns agents directly. Each node calls `dispatch(...)`, bound
to `dispatchNode` in
[`src/pipeline-dispatch.ts`](../../src/pipeline-dispatch.ts), which routes the
phase to its handler (`runScoutPhase`, `runImplementPhase`, …) and consults the
**failure matrix** (`resolveOutcome` from
[`src/dag/outcome-table.ts`](../../src/dag/outcome-table.ts), documented in
[failure-matrix.md](../failure-matrix.md)). The seam is engine-agnostic: the
legacy DAG executor and the LangGraph engine share it, so per-phase semantics
(matrix consult, evidence markers, td mirror, metrics) stay identical.

## Agent runtime: provider routing

The default runtime is `ProviderRoutingRuntime`
([`src/agent/adapters/provider-routing-runtime.ts`](../../src/agent/adapters/provider-routing-runtime.ts)).
Per spawn it resolves the effective `{provider, model}` and dispatches to the
matching backend — routing is driven entirely by the model, no separate knob:

| Model                        | Backend                 | Why                                 |
| ---------------------------- | ----------------------- | ----------------------------------- |
| Claude (Anthropic)           | `ClaudeAgentSdkRuntime` | Subscription/OAuth — resource win   |
| OpenAI / Google / OpenRouter | `LangChainRuntime`      | `createReactAgent` + provider model |

`isClaudeModel` ([`src/agent/config.ts`](../../src/agent/config.ts)) classifies:
`provider === 'anthropic'` → SDK; `provider === 'openrouter'` → LangChain (bills
per-token even when fronting Claude); otherwise the model id is matched against
`/claude|opus|sonnet|haiku/i`. Backends are constructed lazily.

**Override:** `CASE_AGENT_RUNTIME=pi|sdk|langchain` forces one backend (debugging
/ single-backend runs). The `pi` adapter (`@mariozechner/pi-*`) is **deprecated**
— retained only for the interactive steering orchestrator (`ca --agent`).

### Adapters

| Adapter                                                                               | Backend                                      |
| ------------------------------------------------------------------------------------- | -------------------------------------------- |
| [`claude-agent-sdk-adapter.ts`](../../src/agent/adapters/claude-agent-sdk-adapter.ts) | `@anthropic-ai/claude-agent-sdk` (`query`)   |
| [`langchain-adapter.ts`](../../src/agent/adapters/langchain-adapter.ts)               | `@langchain/langgraph` `createReactAgent`    |
| [`pi-adapter.ts`](../../src/agent/adapters/pi-adapter.ts)                             | `@mariozechner/pi-coding-agent` (deprecated) |

### Model resolution

`resolveAgentModel` ([`src/agent/config.ts`](../../src/agent/config.ts)),
precedence highest first:

1. explicit `options.model` (e.g. `ca --model … <issue>`)
2. `CASE_MODEL_OVERRIDE` env
3. per-agent config in `~/.config/case/config.json` (`models.<agent>`)
4. `models.default`, else built-in default (`anthropic` / `claude-sonnet-4-6`)

### Tool policy

`toolPolicyFor` gates the tool surface identically across all three backends:
`implementer` and `retrospective` are `mutable` (Read + Bash + Write/Edit);
every other role is read-only (Read + Bash exploration, no Write/Edit).

## Observability

Each run opens a fire-and-forget `LangfuseTracer` trace. The engine emits
orchestration-level domain events (`revision_requested`,
`revision_budget_exhausted`, `fingerprint_match`); the LangChain adapter
translates tool events into Langfuse spans. Absent config → no sink, run
unaffected.

## Map

| Concern             | File                                                  |
| ------------------- | ----------------------------------------------------- |
| Run entry           | `src/pipeline.ts`                                     |
| Graph engine        | `src/langgraph/engine.ts`                             |
| Graph state         | `src/langgraph/state.ts`                              |
| Crash resume        | `src/langgraph/checkpointer.ts`                       |
| Phase dispatch seam | `src/pipeline-dispatch.ts`                            |
| Failure matrix      | `src/dag/outcome-table.ts` / `docs/failure-matrix.md` |
| Provider routing    | `src/agent/adapters/provider-routing-runtime.ts`      |
| Runtime adapters    | `src/agent/adapters/*-adapter.ts`                     |
| Model resolution    | `src/agent/config.ts`                                 |
