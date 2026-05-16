# Context: Pipeline Glossary

Canonical vocabulary for the case pipeline. Every term used in code, specs, and docs should match these definitions. When a new term is introduced, add it here first.

## Terms

| Term                      | Definition                                                                                                                                                 | Rejected Alternatives                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **task**                  | A unit of agent work dispatched by the pipeline. Has a `taskId`, status, and associated event log.                                                         | `job`, `run` (too generic)                                              |
| **phase**                 | A named pipeline stage that produces one `AgentResult`. One of: implement, verify, review, approve, close, retrospective.                                  | `step` (too generic), `stage` (ambiguous with CI)                       |
| **node**                  | A DAG vertex representing one phase execution at a specific revision cycle. E.g., `implement_0`, `verify_1`. Introduced in Phase 3.                        | `vertex` (too academic)                                                 |
| **status**                | The lifecycle position of a task, derived from pipeline state. One of: active, implementing, verifying, reviewing, evaluating, closing, pr-opened, merged. | `state` (reserved for `PipelineState`, the full reconstructible object) |
| **state**                 | The full reconstructible pipeline state object (`PipelineState`), produced by `reduceEvents()`.                                                            | `snapshot` (used in mill for a different concept)                       |
| **event**                 | An immutable past-tense fact appended to the event log. Events are the source of truth.                                                                    | `action`, `command` (those are imperative; events are facts)            |
| **projection**            | A derived view computed from `PipelineState`. Examples: `TaskJson`, `RunMetrics`, evidence markers.                                                        | `view`, `derivation`                                                    |
| **runtime**               | The `CaseAgentRuntime` interface that abstracts agent spawn/cancel/tool-creation.                                                                          | `provider` (that's the backing service, not the interface)              |
| **adapter**               | A concrete implementation of `CaseAgentRuntime` for a specific provider. E.g., `PiRuntimeAdapter`.                                                         | `driver`, `connector`                                                   |
| **evaluator**             | Collective term for verifier and reviewer — the two phases that assess implementation quality.                                                             | `assessor`, `checker`                                                   |
| **marker**                | A file written to `.case/<task-slug>/` as evidence of a completed phase. E.g., `tested`, `reviewed`.                                                       | `flag`, `sentinel`                                                      |
| **evidence**              | Proof that a phase completed successfully. Includes marker files, SHA-256 hashed test output, screenshots.                                                 | `artifact` (too broad)                                                  |
| **ast-grep rule**         | A YAML file defining a structural code pattern to match or ban. Processed by ast-grep against TypeScript ASTs. Lives in `ast-rules/`.                      | `lint rule` (too generic — we also have oxlint)                         |
| **target rule**           | An ast-grep rule enforcing golden principles in target repos. Run by the implementer before committing. Lives in `ast-rules/target/`.                      | `repo rule`, `external rule`                                            |
| **self-enforcement rule** | An ast-grep rule enforcing case's own codebase invariants. Run in CI and pre-commit. Lives in `ast-rules/self/`.                                           | `internal rule`, `meta rule`                                            |

## Decisions Log

Record vocabulary decisions here as they arise during implementation.

- **Phase 2**: "target rule" vs "self-enforcement rule" split. Target rules enforce golden principles in other repos; self-enforcement rules enforce case's own invariants. Mirrors mill's approach of dogfooding ast-grep on its own codebase.

## Rejected Names

Names considered and explicitly rejected, with rationale. Prevents re-litigating settled decisions.

| Rejected Name          | Context                      | Why Rejected                                                                                |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| `job`                  | Alternative for "task"       | Too generic — conflates with CI jobs, cron jobs                                             |
| `run`                  | Alternative for "task"       | Too generic — conflicts with "pipeline run" (a run executes a task)                         |
| `step`                 | Alternative for "phase"      | Too generic — could mean anything sequential                                                |
| `stage`                | Alternative for "phase"      | Ambiguous with CI stages (GitHub Actions, GitLab CI)                                        |
| `vertex`               | Alternative for "node"       | Too academic — DAG is already abstract enough                                               |
| `state` (for status)   | Alternative for "status"     | Reserved for `PipelineState` — the full reconstructible object, not a scalar position       |
| `snapshot`             | Alternative for "state"      | Used in mill for a different concept (point-in-time capture)                                |
| `action` / `command`   | Alternative for "event"      | Those are imperative; events are past-tense facts                                           |
| `view` / `derivation`  | Alternative for "projection" | Too vague — "projection" is precise: state → derived output                                 |
| `provider`             | Alternative for "runtime"    | That's the backing service (e.g., Pi), not the interface                                    |
| `driver` / `connector` | Alternative for "adapter"    | Too database-y — adapter is the standard GoF pattern name                                   |
| `assessor` / `checker` | Alternative for "evaluator"  | Too vague — evaluator implies structured judgment (rubric)                                  |
| `flag` / `sentinel`    | Alternative for "marker"     | Flag implies boolean toggle; sentinel implies guarding. Markers are evidence artifacts.     |
| `artifact`             | Alternative for "evidence"   | Too broad — artifacts include logs, traces, plans. Evidence specifically proves completion. |
