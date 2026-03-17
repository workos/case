# Case Harness Improvements

## References

Sources informing these improvements:

1. **Stripe Minions** — [YouTube: "Stripe just revealed something big"](https://youtu.be/GQ6piqfwr5c?si=saLsyLHXGWaBJ5bs) — Stripe's unattended AI agents merging 1000+ PRs/week. Key lessons: hybrid deterministic+LLM architecture, context prefetching, tool curation, capped retries, shift feedback left. → Items 15-21
2. **Code Factory: Agent-Driven Code Review Architecture** — [Readwise: Ryan Carson](https://readwise.io/reader/shared/01khqdkf5bm9bnaqzz6sdjtwwx) — Control-plane pattern for fully agent-driven code review. Key lessons: SHA-pinned evidence, machine-readable risk contracts, preflight gating, incident-to-harness loop. → Items 22-27
3. **Self-Improving Agentic Applications** — [Blog: Leading Edje](https://blog.leadingedje.com/post/ai/selfimprovingagenticapplications.html) — JAIMES five-pillar evaluation system with coaching → prompt refinement → versioning cycle. Key lessons: structured metrics over prose, multi-channel evaluation, agent prompt versioning, domain-specific evaluators. → Items 28-32
4. **Harness Engineering Is Cybernetics** — [Blog: Leading Edje](https://readwise.io/reader/shared/01kkhcp388715y8cg2rvk0907x) — Frames harness engineering as feedback-loop control (governor → Kubernetes → AI agents). Key lessons: calibration over capability, externalize all judgment, linters with remediation instructions, parseable output everywhere. → Items 33-36
5. **Give Claude a Computer (Programmatic Tool Calling)** — [Readwise: Anthropic](https://readwise.io/reader/shared/01kkhcqhjefckejjgc0v83x19g) — PTC lets code execute tool calls and process results before they enter context. Key lessons: filter before context, promote-to-tool criteria, context window as scarce resource. → Items 37-39
6. **Mission Control: AI Agent Squad Architecture** — [Readwise](https://readwise.io/reader/shared/01kkhd416bzawfgkdx58zp52rr) — 10 independent AI agents coordinated via shared database (Convex) with 4-layer memory stack, heartbeat cron, and personality-driven roles. Key lessons: working memory layer, file persistence over mental notes, emergent collaboration from shared feeds. → Items 41-42
7. **The Emerging Harness Engineering Playbook** — [Readwise: Charlie Guo](https://readwise.io/reader/shared/01kkhd35qjcpjgrahxen5977hq) — Convergent patterns across Stripe, OpenAI, and OpenClaw. Key lessons: JSON > Markdown for agent state, initializer agent for decomposition, background stale-doc scanning, attended vs unattended parallelization spectrum. → Items 43-46
8. **OpenClaw Agent Swarm Architecture** — [Readwise](https://readwise.io/reader/shared/01kkhd3edcmh8rrj6zzas7ezyy) — Two-tier orchestrator (business context) + coding agents (code context) pattern. Key lessons: context specialization, intelligent respawning with failure analysis, multi-model review, proactive work finding. → Items 47-50
9. **Self-Improving Skills for Agents (cognee-skills)** — [Readwise](https://readwise.io/reader/shared/01kkpb9nhbr03shkh1fyv5t63g) — Closed-loop skill improvement: Ingest → Observe → Inspect → Amend → Evaluate. Graph-based execution history, evidence-grounded amendments with rollback, version tracking with rationale. Key lessons: relational run logs for cross-run correlation, formal prompt snapshots for one-step rollback. → Items 54-55
10. **Skill Issue: Harness Engineering for Coding Agents** — [Blog: HumanLayer](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents) — Practical guide to harness configuration surfaces (CLAUDE.md, MCP, Skills, Sub-agents, Hooks). Cites ETH Zurich study showing auto-generated agent files hurt performance. Key lessons: human review gate for prompt amendments, success-is-silent output rule, tool bloat actively degrades reasoning, two-tier test verification. → Items 51-53, 56
11. **autoresearch** — [GitHub: karpathy/autoresearch](https://github.com/karpathy/autoresearch) — Autonomous LLM training research: agent modifies one file, runs 5-min experiments, keeps or discards based on single metric, loops forever. Human iterates on `program.md` (harness), agent iterates on code. Key lessons: output redirection as context hygiene, keep/discard binary discipline, machine-checkable success metrics, explicit simplicity criterion. → Items 57-60

---

## Prioritized Execution Plan

> **Last revised: 2026-03-14.** All 60 items accounted for: 39 completed, 21 deferred.

### Completed (shipped as of 2026-03-14)

39 items implemented. Kept here for traceability.

| #      | Item                                    | How it shipped                                                                                                                                                                                                  |
| ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Formalize the state machine             | SKILL.md explicit status transitions (active → implementing → verifying → reviewing → closing → pr-opened → merged)                                                                                             |
| **2**  | Extract `$CASE_ROOT`                    | Used throughout scripts                                                                                                                                                                                         |
| **3**  | Document evidence marker formats        | SKILL.md Subagent Output Contract covers .case-tested, .case-reviewed, AGENT_RESULT JSON                                                                                                                        |
| **4**  | Remove closer's duplicate marker checks | Hooks are the single enforcement point (pre-pr-check.sh)                                                                                                                                                        |
| **5**  | Add `.case-reviewed` to `.gitignore`    | Added `.case-reviewed` and `.case-doom-loop-state` to .gitignore                                                                                                                                                |
| **9**  | Document failure recovery               | SKILL.md steps 3-9 route all failures to retrospective                                                                                                                                                          |
| **10** | Document AGENT_RESULT contract          | Fully documented in SKILL.md with exact JSON schema                                                                                                                                                             |
| **15** | Deterministic context prefetching       | `src/context/prefetch.ts` + `assembler.ts` — parallel fetching, role-specific context assembly (implementer gets learnings, verifier gets minimal, closer gets prior AGENT_RESULTs)                             |
| **18** | Cap CI retries                          | Doom-loop detection hook (threshold=3) in doom-loop-detect.sh                                                                                                                                                   |
| **19** | Shift feedback left                     | Implementer section 3 runs typecheck + lint before committing                                                                                                                                                   |
| **22** | SHA-pinned evidence markers             | mark-tested.sh creates output_hash via shasum -a 256                                                                                                                                                            |
| **25** | Incident-to-harness loop                | Retrospective escalates learned patterns to docs/learnings/ and golden-principles.md                                                                                                                            |
| **28** | Structured metrics per run              | Task JSON stores tested/manualTested flags + per-phase agent status/timing                                                                                                                                      |
| **29** | Coaching from metrics                   | Retrospective analyzes task timing and agent phases automatically                                                                                                                                               |
| **30** | Agent prompt versioning                 | `scripts/snapshot-agent.sh` creates snapshots + `docs/agent-versions/changelog.jsonl` tracks version, agent, date, task, reason, contentHash. Retrospective runs snapshot before proposing agent prompt changes |
| **33** | Externalization audit                   | Per-repo learnings files populated (docs/learnings/\*.md), retrospective maintains them                                                                                                                         |
| **34** | Linters with remediation instructions   | check.sh has `FIX:` instructions for every failure                                                                                                                                                              |
| **35** | Parseable output everywhere             | mark-tested.sh, parse-test-output.sh, session-start.sh, entropy-scan.sh all emit structured output                                                                                                              |
| **36** | Kill the advisory dead zone             | golden-principles.md classifies each principle as [enforced] or [advisory] with check commands                                                                                                                  |
| **37** | Pre-filter script output                | session-start.sh gates context gathering; mark-tested.sh redirects raw output to marker file                                                                                                                    |
| **40** | Hybrid orchestration                    | `src/pipeline.ts` while/switch loop + phase modules + AGENT_RESULT parsing. `src/metrics/` per-phase timing + RunMetrics. `src/versioning/prompt-tracker.ts` links runs to prompt versions                      |
| **41** | Working memory (WORKING.md)             | Implementer reads `{task-stem}.working.md` at setup, writes it at end (even on failure). Survives retries                                                                                                       |
| **42** | Cross-run JSONL log                     | `scripts/log-run.sh` appends structured entry to `docs/run-log.jsonl` after each pipeline run. Called from SKILL.md Steps 8 and 9                                                                               |
| **43** | JSON for state, MD for docs             | Task JSON structured; learnings in Markdown — convention established                                                                                                                                            |
| **44** | Initializer decomposition               | from-ideation SKILL.md breaks ideation contracts into sequential phases                                                                                                                                         |
| **45** | Background stale-doc scanning           | entropy-scan.sh with `/loop` support                                                                                                                                                                            |
| **46** | Attended vs unattended modes            | `src/notify.ts` — readline prompts (attended) vs auto-abort (unattended). Task schema `mode` field added                                                                                                        |
| **47** | Context specialization                  | Agents receive role-specific context via SKILL.md routing                                                                                                                                                       |
| **48** | Intelligent respawning                  | SKILL.md Step 4b: on implementer failure, `analyze-failure.sh` classifies error, checks working memory for prior attempts, generates targeted retry context. Max 1 intelligent retry per attempt; in attended mode human can re-enter implement |
| **51** | Human review gate for retrospective     | Retrospective proposes amendments to `docs/proposed-amendments/` instead of direct edits. Only repo learnings applied directly                                                                                  |
| **52** | Success-is-silent output rule           | Scripts output only on failure; mark-tested.sh emits only to stderr                                                                                                                                             |
| **53** | Per-agent tool profiles (enforced)      | Each agent has minimal tool set defined in agent .md frontmatter                                                                                                                                                |
| **54** | Prompt snapshots for one-step rollback  | Snapshots stored as `docs/agent-versions/{agent}-{date}.md`. Changelog enables O(1) lookup of what changed and why. Rollback = copy snapshot back                                                               |
| **55** | Relational fields in run log            | `log-run.sh` now emits `promptVersions` (from changelog), `priorRunId` (previous run for same task), `parentTaskId` (from contractPath for ideation tasks)                                                      |
| **56** | Two-tier test verification              | Implementer runs `vitest --related` (changed files only) before full suite. `fastTestCommand` field in task schema. Fast failure = fix immediately, don't waste full suite                                      |
| **57** | Output redirection pattern              | Implementer Section 2b: redirect all output to log files, grep for results                                                                                                                                      |
| **58** | Keep/discard binary discipline          | Implementer Section 2c: measure progress after each attempt, revert on regression                                                                                                                               |
| **59** | Machine-checkable success condition     | `checkCommand`/`checkBaseline`/`checkTarget` fields in task.schema.json; implementer reads at setup and uses for keep/discard                                                                                   |
| **60** | Explicit simplicity criterion           | Implementer Rules: 3x line ratio gate, deletion-is-a-win heuristic                                                                                                                                              |

### Deferred (do when relevant, not on a schedule)

These are real improvements but don't block anything and can be picked up opportunistically:

| #      | Item                             | When to do it                                                                                                              |
| ------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **6**  | Expand check.sh enforcement      | When adding a new repo or after #36 audit                                                                                  |
| **7**  | Cross-repo architecture overview | When onboarding a new contributor or repo                                                                                  |
| **8**  | Verifier step 3b mandatory       | Next time verifier misses a feature gap                                                                                    |
| **11** | Escalation ladder doc            | After Wave 3 coaching is running                                                                                           |
| **12** | Ideation workflow docs           | Next ideation contract run                                                                                                 |
| **13** | Flesh out learnings files        | Happens naturally as retrospective runs                                                                                    |
| **14** | Expand architecture docs         | When working in under-documented repos                                                                                     |
| **16** | Curated tool subsets             | Superseded by #53; revisit for MCP curation                                                                                |
| **17** | Conditional rules per directory  | When a repo grows large enough to need it                                                                                  |
| **20** | Multiple entry points            | Code exists (`src/server.ts`, webhooks, task factory) but premature; activate when task volume justifies a running service |
| **21** | Pre-warmed environments          | When bootstrap.sh becomes a bottleneck                                                                                     |
| **23** | Machine-readable risk contract   | When risk-tier routing is needed                                                                                           |
| **24** | Preflight gate before CI fanout  | Covered by #19; revisit if CI waste grows                                                                                  |
| **26** | Auto-resolve bot threads         | After multi-run PR workflows exist                                                                                         |
| **27** | SHA dedup for markers            | When running parallel agents on same PR                                                                                    |
| **31** | Domain-specific evaluators       | After metrics show blind spots                                                                                             |
| **32** | Tool call analytics              | After orchestrator can log tool use                                                                                        |
| **38** | Promote-to-tool criteria         | Design exercise, when script count grows                                                                                   |
| **39** | Context window budget per agent  | Applied via #37, #47, #52; formalize if needed                                                                             |
| **49** | Multi-model review               | When single-reviewer blind spots are measured                                                                              |
| **50** | Proactive work finding           | Code exists (`src/entry/scanners/`) but premature; activate when manual task identification becomes a bottleneck           |

### Architecture Note: Orchestrator Core vs Service Layer

The orchestrator was built in waves 4-5 based on patterns from Stripe Minions, OpenClaw, and other production agent systems. After review, the core and service layer have different justifications:

**Orchestrator core (completed, justified at any scale):** The pipeline loop (`src/pipeline.ts`), phase modules, metrics collection, context assembly, and prompt versioning provide deterministic flow control that prose-based orchestration cannot guarantee. The arguments for these are about correctness — code enforces state transitions, retry caps, and context filtering that LLM interpretation of prose can only approximate. See items #40, #15, #46 in the completed table.

**Service layer (deferred, premature for current scale):** The HTTP server (`src/server.ts`), GitHub webhooks (`src/entry/github-webhook.ts`), and background scanners (`src/entry/scanners/`) solve problems at Stripe's scale (1000 PRs/week with auto-triggered agents). Case currently operates at a handful of tasks across 5 repos. The code is left in place and compiles, but the items are deferred until task volume justifies a running service. See items #20 and #50 in the deferred table.

**SDK spawning path (corrected):** `agent-runner.ts` was built with an Agent SDK primary path and Claude CLI fallback. The SDK path bypassed hooks, plugins, and CLAUDE.md — the entire harness enforcement layer. Now corrected to use `claude` CLI exclusively with `--allowedTools` from agent frontmatter and `--permission-mode bypassPermissions` for non-interactive execution. Branch isolation is handled by the `/case` skill layer (branch creation + `.case-active` marker) before the orchestrator runs, so `--worktree` is not needed at the agent-runner level.

---

## Detailed Item Descriptions

Below are the full descriptions for each item, organized by source.

---

## Immediate (fix the foundations)

### 1. Formalize the state machine

Create `docs/conventions/task-lifecycle.md` with the exact state transition graph, who owns each transition, and what happens on failure at each state. Reference it from every agent prompt.

### 2. Extract `$CASE_ROOT`

One variable at the top of each script, derived from the script's own path. Agents reference it instead of hard-coded paths.

### 3. Document undocumented interfaces

Create `docs/conventions/evidence-markers.md` covering `.case-tested` format, `.case-reviewed` format, `AGENT_RESULT` schema, and the credentials file.

### 4. Remove closer's duplicate marker checks

Remove or explicitly label as "sanity check, hook is authoritative." One enforcement point, not two.

### 5. Add `.case-reviewed` to `.gitignore`

Missing from gitignore in target repos; other markers are already listed.

## Important (close the gaps)

### 6. Expand `check.sh` to enforce claimed principles

Add: secret scanning (`.env`, `sk_*` patterns in git history), ESM extension check, TypeScript strict mode check. Drop the "enforced" label from principles that can't actually be checked.

### 7. Add cross-repo architecture overview

Single diagram showing `authkit-session → authkit-nextjs / authkit-tanstack-start` dependency flow, what the CLI consumes, how the skills plugin relates.

### 8. Make verifier step 3b mandatory

"Exercise new code path" must be required for features, not advisory. If verifier doesn't exercise the new export/endpoint, verification is meaningless.

### 9. Document failure recovery

What happens if implementer fails mid-task? Can you restart from current phase? What about reviewer finding criticals — loop back to implementer? Implicit in pipeline but never written down.

### 10. Document AGENT_RESULT contract in agent prompts

Format isn't specified in agent prompts. New agents must infer structure from context. Add format block to each prompt.

## Strategic (compound improvements)

### 11. Create escalation ladder doc

When does a tactical learning become a convention? When does a convention become a golden principle? Retrospective needs this to know when to escalate vs append.

### 12. Document ideation-to-implementation workflow

20+ ideation specs and `/case:from-ideation` skill exist, but no guide explaining contract format, phase ordering, or what happens when a multi-phase contract partially fails.

### 13. Flesh out learnings files

Only `cli.md` has real content. Other repos are stubs. Either retrospective hasn't run enough or it isn't populating them as designed.

### 14. Expand architecture docs

Only cli.md and authkit-session.md are solid. Add "where does concern X belong?" decision tree.

---

## Learnings from Stripe Minions ([YouTube](https://youtu.be/GQ6piqfwr5c?si=saLsyLHXGWaBJ5bs))

Stripe's internal AI agents ("Minions") merge 1000+ PRs/week fully unattended. The agent itself is a fork of Goose (open source). The value is entirely in the six-layer harness around it. Here's what maps to Case:

### What Case already does well (validated by Stripe)

- **Hybrid architecture.** Stripe interleaves creative LLM steps with deterministic gates — linter always runs, git commit is hardcoded, not optional. Case does this with hooks (pre-commit, pre-push, pre-PR). This is the single most important design decision for unattended reliability.
- **The harness is the product.** Stripe's agent is commodity (Goose fork). Case's philosophy ("when agents struggle, fix the harness") is the same insight.
- **Evidence-based gating.** Stripe's 3-tier feedback (local lint → selective CI → agent self-fix) maps to Case's marker system (`.case-tested` → `.case-manual-tested` → `.case-reviewed`). Both enforce that the agent can't skip steps.
- **Agent separation.** Stripe isolates each agent in its own dev box. Case isolates each agent into a single-responsibility phase with restricted tools. Same principle, different mechanism.

### What Case should steal

#### 15. Deterministic context prefetching

Stripe's orchestrator prefetches context _before_ the agent starts — scans the prompt for links, pulls ticket details, searches code via Sourcegraph. No LLM decision-making. All deterministic. Case's `session-start.sh` is minimal by comparison. **Action:** Expand session-start to deterministically pull in: linked issues/PRs, relevant learnings, repo architecture doc, recent git log for changed files. The agent should wake up with rich context already loaded.

#### 16. Curated tool subsets

Stripe has 400+ MCP tools but agents see ~15 relevant ones. "If you give an LLM 400 tools, it wastes tokens figuring out which ones matter." Case agents currently get a flat tool list. **Action:** Define per-agent tool profiles. Implementer doesn't need PR tools. Verifier doesn't need edit tools (already done via agent definitions). But also consider MCP tool curation — agents shouldn't see every MCP server, only what's relevant to their phase.

#### 17. Conditional rules per directory

Stripe applies rules per subdirectory — payments code gets payments rules, billing gets billing rules. Case uses one global ruleset (golden-principles.md). **Action:** For repos with distinct domains (e.g., CLI has commands/ vs lib/), support scoped CLAUDE.md rules or per-directory context injection. Prevents context window waste on irrelevant rules.

#### 18. Capped CI retries (max 2 rounds)

"If the LLM can't fix in 2 attempts, a third won't help. You're just burning tokens." Case has doom-loop detection at 3 consecutive identical failures, but no hard cap on CI rounds. **Action:** Add a hard cap: 1 initial push + 1 retry. After that, surface to human with what was tried. This is more pragmatic than waiting for the doom loop fingerprint to match.

#### 19. Shift feedback left

Stripe's 3 tiers catch errors as early and cheaply as possible: local lint (<5 sec), then selective CI, then agent self-fix. Case runs everything through the full pipeline sequentially. **Action:** Add a fast local validation tier to the implementer — run linter + typecheck + fast unit tests _before_ committing. Catch 80% of issues in seconds instead of waiting for the full verifier phase.

#### 20. Multiple entry points

Stripe minions start from Slack, CLI, web UI, or auto-triggered by CI (flaky test → one-click "fix it" button). Case only starts from task files. **Action:** Consider Slack/GitHub issue integration as entry points. When CI fails on a known pattern, auto-create a task file. Lower the friction to start an agent run.

#### 21. Pre-warmed environments

Stripe dev boxes spin up in ~10 seconds, pre-warmed with code and services. Case relies on `bootstrap.sh` which clones/pulls at agent start time. **Action:** Keep target repos pre-cloned and dependencies pre-installed. `bootstrap.sh` should validate readiness, not create it from scratch.

### Key takeaway

> "The tool that wins isn't the one with the best model. It's the one with the best infrastructure around the model."

Case is already building the right thing. The biggest gaps vs Stripe are (1) deterministic context prefetching before agent start, (2) shifting feedback left with fast local validation, and (3) hard-capping retries instead of waiting for doom loop detection. All three are achievable without major architectural changes.

---

## Learnings from "Code Factory: Agent-Driven Code Review Architecture" ([Readwise](https://readwise.io/reader/shared/01khqdkf5bm9bnaqzz6sdjtwwx))

Ryan Carson describes a control-plane pattern for fully agent-driven code: agent writes → repo enforces risk checks → review agent validates → machine-verifiable evidence → findings become test cases. Nine components, tool-agnostic by design.

### What Case already does well (validated by this article)

- **Browser evidence as first-class proof.** Carson mandates machine-verifiable browser evidence for UI changes (`capture-browser-evidence` / `verify-browser-evidence`). Case already does this with `.case-manual-tested` + Playwright screenshots. Validated.
- **Deterministic gates, not agent discretion.** The article's core thesis — interleave creative LLM steps with hardcoded gates — is Case's hook architecture. Linter always runs, commit format enforced, PR gated by markers. Same principle.
- **Automated remediation loop.** Carson describes: absorb review context → patch → validate → push fix. Case's implementer → verifier → reviewer pipeline is this loop. The difference is Case runs it as sequential agent phases; Carson runs it as an in-PR cycle.
- **Findings-driven review.** Carson's review agent produces structured findings with severity. Case's reviewer does the same (critical/warning/info with principle references).

### What Case should steal

#### 22. SHA-pinned evidence markers (CRITICAL)

Carson calls this "the biggest practical lesson from real PR loops." Evidence must be tied to the current HEAD SHA. Case's `.case-tested` and `.case-reviewed` markers **don't track which commit they were created against.** If the implementer pushes another commit after testing, the markers are stale but still pass the pre-PR hook. **Action:** `mark-tested.sh` and `mark-reviewed.sh` must record the HEAD SHA. `pre-pr-check.sh` must verify markers match current HEAD. Stale markers = fail.

#### 23. Machine-readable risk contract

Carson consolidates risk tiers, merge policy, required checks, and evidence requirements into a single JSON file. Case has `golden-principles.md` (prose) and `pre-pr-check.sh` (code) — two sources of truth that can drift. **Action:** Create a `risk-policy.json` that maps file path patterns to risk tiers, each tier to required checks (lint, test, browser evidence, review). Scripts and hooks read this file instead of hardcoding rules. Single source of truth, machine-readable.

#### 24. Preflight gate before CI fanout

Carson's ordering: run risk-policy-gate _first_, verify deterministic policy + review state, _then_ trigger expensive CI jobs. Case runs everything in sequence but doesn't short-circuit — if the linter would catch a type error, the full pipeline still runs. **Action:** Add a fast preflight to the implementer phase: typecheck + lint + risk-tier classification. If preflight fails, fix before running tests. Don't waste a full CI cycle on a type error.

#### 25. Incident-to-harness loop

Carson: `production regression → harness gap issue → test case added → SLA tracked`. Case has retrospective → learnings, but no pipeline from production incidents back to test cases. **Action:** When a bug is found post-merge, the retrospective should not just add a learning — it should add a concrete test case or check.sh rule that prevents recurrence. Learnings are knowledge; test cases are enforcement.

#### 26. Auto-resolve stale bot threads on clean rerun

After a clean review rerun, Carson auto-resolves threads containing only bot comments. Case's reviewer creates PR comments (via closer), but there's no cleanup if findings are fixed and re-reviewed. **Action:** When closer creates a PR, if prior review findings were addressed, mark them as resolved. Reduces noise for human reviewers.

#### 27. Single rerun source with SHA dedup

Carson found that multiple workflows requesting reruns create duplicate comments and race conditions. Solution: exactly one canonical workflow as rerun requester, with SHA-tagged dedup markers. Not an immediate Case problem (single pipeline), but relevant when scaling to parallel agent runs on the same PR. **Action:** Design the marker system to be idempotent from the start. If two agents produce markers for the same SHA, dedup rather than overwrite.

### Key takeaway

> "Current-head SHA discipline is the biggest practical lesson from real PR loops."

Case's most critical gap from this article is **#22: SHA-pinned evidence markers.** Without it, a post-test commit silently invalidates all evidence but the pre-PR hook still passes. This is a correctness bug in the gating system, not just a nice-to-have. Fix this before anything else from this list.

---

## Learnings from "Self-Improving Agentic Applications" ([Blog](https://blog.leadingedje.com/post/ai/selfimprovingagenticapplications.html))

JAIMES is a self-improving AI system with a five-pillar evaluation pipeline feeding a coaching → prompt refinement → versioning → testing cycle. The memory and self-improvement patterns are directly relevant to Case's retrospective and learnings system.

### The core problem with Case's current memory

Case's retrospective appends prose to `docs/learnings/*.md`. That's **one feedback channel producing unstructured text**. It has three weaknesses:

1. **No measurement.** Learnings say "X happened" but don't quantify frequency, severity, or trend. There's no way to know if a problem is getting better or worse.
2. **No systematic refinement.** Retrospective appends learnings but doesn't use them to systematically modify agent prompts. The connection from "we learned X" to "agent prompt now reflects X" is manual and ad-hoc.
3. **No versioning or benchmarking.** When retrospective modifies an agent prompt, there's no way to measure whether the change helped, hurt, or did nothing. No rollback path.

JAIMES solves all three with: evaluate (5 channels) → coach (generate improvement statements) → refine (modify prompts) → version (tag new version) → test (replay scenarios against old version) → activate (if better).

### What Case should steal

#### 28. Multi-channel evaluation metrics

JAIMES uses 5 measurement channels: direct feedback, sentiment classification, AI message evaluation, tool call analysis, and conversation-level analysis. Case has exactly one: retrospective prose. **Action:** Track structured metrics per agent run:

- **Task outcome:** completed / failed / doom-looped / human-rescued
- **CI pass rate on first push:** did implementer's code pass tests without retries?
- **Reviewer finding density:** critical/warning/info counts per run, by principle
- **Phase duration:** time per agent phase (identifies bottlenecks)
- **Doom loop frequency:** how often does the detector fire, on which commands?

Store these in task JSON (already has `agents.*` fields) or a dedicated `metrics.json` per completed task. Retrospective reads these instead of guessing from prose.

#### 29. Coaching generation from metrics, not vibes

JAIMES feeds all 5 measurement streams into separate LLM prompts that generate "coaching statements." These are targeted improvement directives, not general observations. Case's retrospective generates learnings by reading the progress log — essentially vibes-based. **Action:** Retrospective should:

1. Read structured metrics from the completed task
2. Compare against baseline metrics from previous runs on same repo
3. Generate specific coaching statements: "Implementer's first CI push failed 4 of last 5 runs on cli repo due to missing `.js` extensions. Add ESM extension reminder to implementer prompt section 3."
4. Distinguish _recurring_ patterns (fix the prompt) from _one-off_ issues (just log it)

#### 30. Agent prompt versioning

JAIMES versions every agent configuration and benchmarks new versions against test scenarios before activation. Case overwrites agent prompts in-place with no history beyond git log. **Action:** When retrospective modifies an agent prompt:

1. Record the change in a changelog (e.g., `docs/agent-changelog.md`) with: date, which agent, what changed, which metrics motivated it, which task triggered it
2. After the next run with the modified prompt, compare metrics against the baseline
3. If metrics regressed, flag for human review (don't auto-revert — context matters)

This closes the loop: metric → coaching → prompt change → metric again.

#### 31. Domain-specific evaluators for agent failure modes

JAIMES builds custom evaluators for specific failure modes (brevity, player agency violations, story flow stagnation). Case's reviewer checks golden principles but doesn't evaluate _agent-specific_ failure modes. **Action:** Define evaluators for known failure patterns:

- **Implementer over-engineering:** diff size vs task complexity (LOC added for a "fix typo" task)
- **Implementer scope creep:** files changed outside the task's stated scope
- **Verifier false positives:** verification passes but reviewer finds critical issues (means verifier missed something)
- **Closer template drift:** PR description missing required sections

These can be simple heuristics, not LLM calls. Log results to metrics.

#### 32. Tool call analytics

JAIMES logs every tool invocation and does aggregate analytics to find underutilized or overutilized tools. Case doesn't track tool usage at all. **Action:** Log which tools each agent invokes (already available in Claude Code telemetry). Look for patterns:

- Agent repeatedly Greps for something it never finds → missing context in session-start
- Agent calls Bash excessively instead of dedicated tools → prompt needs "use Glob not find" reminder
- Agent never uses a tool it was given → remove it from the curated set (#16)

Low effort to collect (hook on tool use), high signal for prompt refinement.

### What to be cautious about

#### Cost multiplication

JAIMES estimates 5-10x LLM cost for evaluation overhead. Case should keep evaluation cheap:

- Use structured metrics (JSON, not LLM calls) for channels 28 and 32
- Use retrospective's existing LLM call for coaching (#29) — no new agent phase needed
- Don't evaluate every message; evaluate per-run outcomes

#### Cascading impact of tweaks

JAIMES found that "tweaks to the LLM, system prompt, tools, or RAG context can significantly impact performance in unexpected ways." This reinforces #30 (versioning): never change multiple agent prompts at once. One change, one measurement cycle.

### Key takeaway

> Case's retrospective is a one-channel, vibes-based, unversioned feedback system. The path to real self-improvement is: structured metrics → targeted coaching → versioned prompt changes → measured outcomes.

The single highest-leverage change is **#28 (structured metrics per run)**. Without measurement, everything else is guessing. Start logging task outcomes, CI pass rates, and finding density in task JSON. The retrospective can then do real analysis instead of reading prose and appending more prose.

---

## Learnings from "Harness Engineering Is Cybernetics" ([Readwise](https://readwise.io/reader/shared/01kkhcp388715y8cg2rvk0907x))

Frames harness engineering through the cybernetics lens: governor → Kubernetes → AI agents. Same pattern each time — sensors and actuators become powerful enough to close feedback loops at a previously manual layer, and work shifts from doing to steering. The practical takeaways sharpen several existing improvements and add new ones.

### What Case already does well (validated)

- **The governor pattern.** Case's hooks are literal governors — they sense state (markers, commit format, branch) and actuate (block or allow). The article validates this as the correct architecture: "You stop turning the valve. You steer."
- **Externalized knowledge.** Golden principles, learnings files, architecture docs, playbooks — Case has already externalized more judgment than most harness setups. The article warns: "Agents don't learn through osmosis. If you don't write it down, the agent makes the same mistakes on the hundredth run as the first." Case does write it down.
- **Generation vs verification asymmetry.** Case's pipeline separates generation (implementer) from verification (verifier, reviewer) — matching the article's P-vs-NP framing that verification is fundamentally easier than generation.

### The core challenge this article highlights

> "The agent isn't failing because it lacks capability. It's failing because the knowledge it needs is locked inside your head, and you haven't externalized it."

OpenAI spent 20% of every Friday cleaning up "AI slop" — until they encoded their standards into the harness. The penalty for NOT externalizing is no longer gradual decline; it's convention violations on every PR at machine speed.

**The question for Case:** What knowledge is still locked in heads?

### What Case should steal

#### 33. Externalization audit

The article's central argument: agents fail from inadequate calibration, not capability. Knowledge locked in engineers' heads produces identical mistakes on run 100 as run 1. **Action:** Do a systematic audit of what's externalized vs what's implicit:

- Which architectural decisions are documented vs assumed? (e.g., "we never use default exports" — is that in golden principles or just convention?)
- Which code review preferences are in the reviewer prompt vs in the engineer's head? (e.g., "we prefer composition over inheritance" — stated anywhere?)
- Which debugging heuristics does the implementer need but doesn't have? (e.g., "when vitest hangs, it's usually a missing mock cleanup")
- What does "good" look like for each repo? Not just "tests pass" but "this is the style, these are the patterns, this is how we handle errors here"

Add findings to learnings files, architecture docs, or golden principles as appropriate. This is the single cheapest high-impact improvement — it's just writing things down.

#### 34. Linters with embedded remediation instructions

The article calls out "custom linters with embedded remediation instructions" as a required practice. Case's `check.sh` reports violations but doesn't tell the agent _how to fix them_. **Action:** For every check in `check.sh` and every enforced golden principle, add a remediation hint:

- Bad: `"FAIL: Missing .js extension in import"`
- Good: `"FAIL: Missing .js extension in import at src/foo.ts:42. Fix: change './bar' to './bar.js'. All ESM imports must use explicit .js extensions (golden principle #14)."`

The agent reads stderr. If the error message contains the fix, the agent fixes it in one shot instead of searching for context. This directly reduces CI retry cycles (reinforces #18 and #19).

#### 35. Parseable output everywhere

The article emphasizes "fast feedback loops with parseable output." Case's scripts produce a mix of human-readable text and structured data. **Action:** Every script that agents consume should output structured JSON (or at minimum, machine-parseable format):

- `check.sh` → JSON array of `{check, status, message, remediation}`
- `session-start.sh` → JSON with `{repo, branch, taskFile, learnings, recentCommits}`
- `mark-tested.sh` → already structured (good)
- `pre-pr-check.sh` → JSON array of `{gate, passed, reason}`

Agents parse JSON reliably. They parse prose unreliably. This is the same insight as #28 (structured metrics) applied to all script output.

#### 36. Cost-of-skipping enforcement

The article's enforcement argument: "Skip documentation → agent violates conventions on every PR at machine speed." Case has advisory golden principles (#8-13, #17) that aren't enforced. For human engineers, advisory is fine — they learn over time. For agents, advisory means ignored. **Action:** For each advisory principle, decide:

- **Promote to enforced:** add a check to `check.sh` or a hook, with remediation instructions (#34)
- **Demote to informational:** remove from golden principles, move to architecture docs as context
- **Keep advisory but add to agent prompts:** if it can't be mechanically checked, embed it directly in the relevant agent's prompt so it's in-context, not in a doc the agent might not read

The middle ground of "advisory golden principle" is a dead zone for agents. It looks enforced but isn't.

### Key takeaway

> "The practices haven't changed. The penalty for ignoring them has become unbearable."

Case's architecture is right. The risk is in the gaps — knowledge still in heads (#33), error messages without fixes (#34), output that's human-readable but not machine-parseable (#35), and advisory rules that agents silently ignore (#36). These aren't new practices to adopt; they're existing practices to finish.

---

## Learnings from "Give Claude a Computer" (Programmatic Tool Calling) ([Readwise](https://readwise.io/reader/shared/01kkhcqhjefckejjgc0v83x19g))

Anthropic's Programmatic Tool Calling (PTC) lets Claude generate code that executes in a sandbox. Tool results return to the running code — not Claude's context — so intermediate processing happens before the model sees anything. Result: 11% accuracy improvement, 24% fewer input tokens.

PTC itself is an API-level feature, not something Case implements directly. But the principles behind it expose a weakness in how Case manages agent context.

### The principle Case should internalize

> "Each round trip serializes the tool result into context — it will pass thousands of rows even if the next step only needs five."

Case agents routinely consume raw, unfiltered output: full git diffs, entire file contents, verbose test output, multi-page check.sh results. All of it enters the context window at full fidelity. The agent then reasons about what matters — burning tokens and attention on content it'll discard.

The PTC insight: **filter before context, not after.**

### What Case should steal

#### 37. Pre-filter script output before it enters agent context

Session-start, check.sh, git diff, test output — these all dump raw results into the agent's context window. The agent then mentally filters to what matters. **Action:** Scripts should do the filtering:

- `session-start.sh` should return a curated context summary, not raw file contents. Recent commits relevant to the task, not the full log. Learnings for this repo, not all repos.
- `check.sh` output should be failures-only by default (agents don't need to see 47 passing checks to process 2 failures)
- `parse-test-output.sh` already exists but isn't used consistently. Test output should always be parsed to structured pass/fail/error before the agent sees it.
- Git diffs for reviewer should be pre-filtered to changed hunks only, not full file context (the agent can Read specific files if it needs surrounding context)

This reinforces #35 (parseable output) but goes further: not just structured, but _minimal_. Only surface what the agent needs to act on.

#### 38. Apply the "promote to tool" criteria to Case scripts

The article identifies 5 reasons to make something an explicit tool rather than inline code: UX rendering, guardrails enforcement, concurrency control, observability isolation, and autonomy levels. Case currently has scripts that agents call via Bash — no structure around which scripts warrant tool-level treatment. **Action:** Evaluate each Case script against these criteria:

- **Guardrails:** `mark-tested.sh`, `mark-reviewed.sh`, `task-status.sh` — these enforce state transitions and should have guardrail-level validation (some already do, like rejecting evidence writes without `--from-marker`)
- **Observability:** `session-start.sh`, `check.sh` — these produce diagnostic output worth logging separately from the agent's main reasoning
- **Concurrency:** Read-only scripts (check.sh, session-start.sh) could run in parallel during preflight; state-mutating scripts (mark-tested, task-status) must be sequential

This is a design lens, not an implementation change. But applying it systematically would clarify which scripts need guardrails vs which are just utilities.

#### 39. Treat the context window as a scarce resource

PTC's 24% input token reduction comes from one insight: don't put things in context that code can handle. Case agents operate in long sessions with large context windows, but context is still finite and attention degrades with length. **Action:** Audit what enters agent context across a full pipeline run:

- How many tokens does session-start inject? Is all of it used?
- How much of check.sh output does the implementer actually act on?
- Does the reviewer read the full diff or only changed files? (If only changed files, don't inject the full diff)
- Does the closer need the full progress log, or just the latest phase results?

For each agent, define a "context budget" — not a hard limit, but a design target. If session-start is injecting 5,000 tokens but the agent only acts on 500, the script is doing 10x too much work.

### What's NOT practical for Case right now

PTC requires the Anthropic API with code execution containers. Case uses Claude Code agents (which have their own tool infrastructure). Case can't use PTC directly — but it can apply the same principle through script design: filter, summarize, and minimize what enters context. The scripts are Case's "code execution layer."

### Key takeaway

> Context is attention. Everything that enters the agent's context window competes for reasoning capacity. Filter before context, not after.

This reinforces a thread across multiple improvements: #15 (deterministic context prefetching), #16 (curated tool subsets), #35 (parseable output), and now #37-39. The common principle is that **the harness should do the work of selecting and filtering, so the agent can focus on reasoning and acting.** Every token of noise in context is a token of signal the agent might miss.

---

## Architectural: Hybrid orchestration (informed by all 5 sources)

### 40. Extract orchestration from prose to code

Every article converges on the same architecture: **deterministic orchestration wrapping creative LLM agents.** Stripe's harness interleaves hardcoded gates with agent steps. Carson's control-plane runs preflight → review → remediation as programmatic flow. JAIMES versions prompts and benchmarks programmatically. The cybernetics framing is literal: a governor is code, not a suggestion.

Case's orchestration layer is currently SKILL.md — prose that Claude Code interprets as a flowchart. This works, but it means:

- **Flow control is LLM-interpreted, not deterministic.** "If reviewer finds criticals, loop back to implementer" is a sentence the model reads and hopefully follows. It's not an `if/else` a runtime executes.
- **Retry caps are reactive, not proactive.** Doom loop detection fires after 3 identical failures via a hook. A programmatic orchestrator would cap retries as a loop condition before they happen (#18).
- **No persistent process.** Can't receive Slack messages, GitHub webhooks, or CI triggers. Every run is a fresh session (#20).
- **No cross-run state.** Aggregate metrics (#28), coaching from baselines (#29), and prompt benchmarking (#30) all need a store that survives across sessions. Files can approximate this, but querying "CI pass rate across last 10 runs on cli repo" from flat files is fragile.
- **No parallel coordination.** Stripe runs 5 agents in parallel on independent dev boxes. Case runs phases sequentially because the SKILL.md prose can only express serial flow.

**The recommendation is hybrid, not migration.** Keep the plugin primitives that work well. Move orchestration to code.

#### What stays as Claude Code plugin primitives

- **Agent `.md` prompts** — excellent for defining role, tools, constraints, and style. These become prompt templates the orchestrator loads.
- **Hooks** (pre-commit, pre-push, pre-PR) — perfect as enforcement gates. They run inside the agent's session and block bad actions mechanically. No reason to move these.
- **Skills** — entry points for human-initiated work in the CLI. Keep `/case` and `/case:from-ideation` as CLI shortcuts that invoke the orchestrator.
- **Learnings files** — knowledge agents read at start. Simple, effective, no runtime dependency.

#### What moves to a programmatic orchestrator (Agent SDK, or similar)

- **Pipeline flow control** — `implementer → verifier → reviewer → closer` as a real loop with `if/else`, retry caps, and error handling. Not prose. Code.
- **Metrics collection** — structured data emitted after each phase, persisted to a store (SQLite, JSON-lines file, or external DB). Queryable across runs.
- **Entry points** — Slack bot, GitHub webhook handler, CI failure trigger. All create task objects and invoke the pipeline programmatically.
- **Context assembly** — deterministic prefetching (#15) before spawning each agent. The orchestrator gathers repo state, learnings, recent commits, linked issues — then injects a curated context payload into the agent prompt.
- **Prompt versioning** — load agent prompts from versioned configs. After each run, record which version was used alongside metrics. Compare across versions (#30).
- **Parallel execution** — spawn multiple agent phases (or multiple tasks) concurrently when they don't share state.

#### What this looks like concretely

```
CLI / Slack / GitHub webhook / CI trigger
  │
  ▼
Orchestrator (TypeScript, Agent SDK)
  ├── reads risk-policy.json (#23)
  ├── assembles context deterministically (#15, #37)
  ├── loads agent prompt template (agents/implementer.md)
  ├── spawns Claude agent with curated tools (#16) and filtered context
  ├── collects structured result (AGENT_RESULT JSON)
  ├── records metrics (#28)
  ├── decides next phase (deterministic if/else, not LLM interpretation)
  ├── caps retries (#18)
  └── on completion: runs retrospective, updates prompt version scores (#30)
```

The agent `.md` files don't change. The hooks don't change. The scripts don't change. What changes is that the thing reading SKILL.md and deciding "now spawn the verifier" is a TypeScript program, not an LLM interpreting prose.

#### Why not full migration

The plugin model gives three things that are hard to replicate:

1. **Hook enforcement inside the agent session** — pre-commit, pre-push hooks fire because Claude Code runs them. An external orchestrator would need to replicate this.
2. **Interactive human steering** — `/case` in the CLI lets engineers intervene mid-pipeline. Pure SDK agents are fire-and-forget.
3. **Agent prompt iteration speed** — editing a `.md` file and re-running is faster than redeploying an SDK application.

The hybrid preserves all three. The orchestrator invokes `claude --worktree` (or Agent SDK) with the right prompt and context. Hooks still fire inside the session. Engineers can still intervene via the CLI for interactive work while the orchestrator handles unattended runs.

#### Migration path

This doesn't need to be a big bang. The seam already exists — SKILL.md steps 1-9 are the orchestrator's logic:

1. **Phase 1:** Formalize SKILL.md's flow as a state machine doc (#1). No code yet, just make the implicit logic explicit.
2. **Phase 2:** Build a minimal TypeScript orchestrator that reads a task file, spawns the implementer via `claude` CLI, and collects the result. One agent, one phase. Validate the pattern.
3. **Phase 3:** Add remaining phases (verifier, reviewer, closer). The orchestrator now runs the full pipeline as code.
4. **Phase 4:** Add metrics collection (#28), entry points (#20), and prompt versioning (#30). These are natural extensions once you have a persistent process.
5. **Phase 5:** Add Slack/webhook integration. The orchestrator becomes a service.

Each phase is independently valuable. Phase 2 alone gives deterministic flow control and retry caps. Phase 4 unlocks the self-improvement cycle from items 28-32.

---

## Learnings from "Mission Control," "Emerging Harness Engineering Playbook," and "OpenClaw Agent Swarm" ([Refs 6-8](#references))

Three articles from different practitioners converging on similar patterns. The Mission Control piece runs 10 marketing/content agents via shared database. Guo's playbook synthesizes patterns across Stripe, OpenAI, and OpenClaw. The OpenClaw swarm article details a two-tier orchestrator + coding agent architecture. Taken together, they fill gaps in how Case handles memory, context specialization, failure recovery, and decomposition.

### What Case already does well (validated across all three)

- **Worktree-per-agent isolation.** The OpenClaw swarm uses `git worktree` for every agent — identical to Case's `--worktree` pattern. Validated as correct approach for parallel work.
- **Agent role separation.** All three articles enforce single-responsibility agents. Mission Control goes further with personality files (SOUL.md), but the principle is the same: constrained roles outperform generalists. Case's 5-agent pipeline already does this.
- **Documentation as system of record.** Guo: "Anytime you find an agent makes a mistake, you take the time to engineer a solution such that the agent never makes that mistake again." Case's retrospective → learnings loop is exactly this pattern.
- **Definition of Done with multiple gates.** OpenClaw requires: PR created, no merge conflicts, lint/TS/unit/E2E pass, 3 AI reviews approved, screenshots included. Case's pre-PR hook checks markers similarly. Same principle.

### What Case should steal

#### 41. Working memory layer

Mission Control uses a 4-layer memory stack: session memory → working memory (WORKING.md) → daily notes → long-term memory (MEMORY.md). Case has long-term (learnings files) but **no working memory** — no "what happened last run, what's the current state of this task across sessions." When an agent run fails or is interrupted, the next session starts cold. **Action:** Add a `WORKING.md` per active task (or per target repo) that records:

- Current pipeline phase and status
- What the last agent attempted and whether it succeeded
- Specific blockers or partial progress
- Files changed so far

The implementer writes this at the end of its run (even on failure). The next session — whether retry or next phase — loads it immediately. Golden rule from Mission Control: "If you want to remember something, write it to a file. Mental notes don't survive session restarts."

#### 42. Daily run log for pattern detection

Mission Control keeps daily notes (YYYY-MM-DD.md) as raw activity logs. Case has no cross-run log — each task has its own progress log, but there's no timeline view of "what happened across all tasks today/this week." **Action:** Append a structured entry to `docs/run-log.jsonl` after each pipeline run:

```json
{
  "date": "2026-03-12",
  "task": "cli-2-one-shot-mode",
  "repo": "cli",
  "outcome": "completed",
  "phases": { "implementer": "pass", "verifier": "pass", "reviewer": "pass", "closer": "pass" },
  "metrics": { "ciFirstPush": true, "reviewFindings": { "critical": 0, "warning": 2 }, "duration_min": 34 }
}
```

This feeds directly into #28 (structured metrics) and #29 (coaching from metrics). The retrospective reads the log to detect patterns across runs, not just within one task.

#### 43. JSON for agent-writable state, Markdown for human-readable docs

Anthropic discovered that "agents were less likely to edit or overwrite structured data inappropriately" when using JSON instead of Markdown. Case uses Markdown for learnings files — which agents append to. This is a risk: an agent could accidentally overwrite existing learnings, misformat the file, or append duplicates. **Action:** Split the concern:

- **JSON** for structured state that agents write: metrics, run logs, task status, evidence markers (most of these are already JSON — good)
- **Markdown** for human-readable knowledge that agents append to: learnings, architecture docs, playbooks
- **Rule:** Agents never _edit_ Markdown learnings — they only _append_. The retrospective is the only agent that curates (removes duplicates, promotes to conventions). This is already the intent but not enforced.

#### 44. Initializer agent for task decomposition

Anthropic uses an "initializer agent" that generates 200+ individual features from high-level prompts, each with explicit test steps, all initially marked "failing." Case's ideation skill (`/ideation`) does high-level decomposition, but the output is prose specs, not testable feature lists. **Action:** For complex tasks (especially from ideation), add a decomposition step before the implementer:

- Break the spec into discrete, testable items (e.g., "function X returns Y when given Z")
- Each item has: description, acceptance test, status (failing → passing)
- Implementer works through the list, marking items as it goes
- Verifier checks items against actual behavior
- Progress is visible and measurable — not "I think I'm 70% done"

This is more structured than ideation phases but less heavyweight than a full planning agent. It gives the implementer a checklist instead of a wall of prose.

#### 45. Background stale-doc scanning

OpenAI runs a background agent that periodically scans for stale documentation and opens cleanup PRs — "agents creating documentation for agents, by agents." Case has entropy-management.md as a convention and entropy-scan.sh as a script, but no automated scanning on a schedule. **Action:** With the programmatic orchestrator (#40), add a periodic job:

- Run `entropy-scan.sh` across all target repos weekly
- If drift detected (stale CLAUDE.md, outdated architecture docs, learnings that contradict current code), create a task for the retrospective agent
- Low cost, high compound value — prevents the slow rot that makes agent prompts less accurate over time

#### 46. Attended vs unattended spectrum

Guo identifies two parallelization models: **attended** (5-10 agents, active management, frequent check-ins) and **unattended** (post task in Slack, walk away, review PR later). Most teams operate in the middle. Case currently only supports attended (engineer runs `/case`, watches pipeline). **Action:** Explicitly design for both modes:

- **Attended (current):** `/case` in CLI, engineer monitors, can intervene. Keep this.
- **Unattended (new, via #40 orchestrator):** task file dropped in `tasks/active/`, orchestrator picks it up, runs full pipeline, notifies on completion. Engineer returns only at PR review.
- The harness maturity determines which tasks qualify for unattended: well-scoped bug fixes with clear reproduction → unattended. Architectural refactors → attended. Make this explicit in task templates.

#### 47. Context specialization between orchestrator and agents

The OpenClaw swarm's core insight: "Context windows are zero-sum. You have to choose what goes in." Their orchestrator (Zoe) holds business context (customer data, meeting notes, decisions). Coding agents hold code context (types, test paths, codebase). Neither sees the other's context. Case currently dumps everything into every agent — task description, learnings, architecture docs, repo context. **Action:** Define a context budget per agent role:

- **Implementer context:** task spec, relevant learnings for this repo, architecture doc, recent related commits. NOT: review conventions, PR templates, retrospective patterns.
- **Verifier context:** task spec (what to test), implementer's commit summary, test infrastructure docs. NOT: implementation details, learnings about code style.
- **Reviewer context:** diff, golden principles, previous findings for this repo. NOT: task spec details, implementation rationale.
- **Closer context:** task spec, reviewer findings, PR template. NOT: code details, test output.

Each agent gets only what it needs to act. This directly implements #39 (context as scarce resource) at the architectural level.

#### 48. Intelligent respawning with failure analysis

When an OpenClaw agent fails, the orchestrator doesn't just retry with the same prompt. It analyzes the failure with full context and adjusts: "Out of context? Focus on these 3 files. Wrong direction? Here's the meeting transcript." Case's doom loop detector blocks after 3 identical failures, but there's no analysis or prompt adjustment between retries. **Action:** When implementer fails (tests don't pass after commit, or doom loop triggers):

1. Capture the failure: which tests failed, what error messages, what the agent last attempted
2. Pass the failure context to the orchestrator (or a lightweight analysis step)
3. Generate an adjusted prompt: "Previous attempt failed because X. Focus on Y instead. Avoid Z."
4. Respawn with the adjusted prompt and a fresh context window

This turns "blocked, surface to human" into "retry once with targeted adjustment, then surface to human." One intelligent retry is worth more than three identical retries.

#### 49. Multi-model review

The OpenClaw swarm uses 3 different AI reviewers, each with different strengths: Codex (edge cases, race conditions, low false positives), Gemini (security, scalability), Claude (validation layer, tends over-cautious). Case uses one reviewer agent. **Action:** This isn't an immediate priority, but worth designing for:

- If reviewer findings are consistently missing certain categories (security, performance), consider adding a specialized second review pass
- Different models have different blind spots — one reviewer with one model creates systematic gaps
- Low-cost version: run reviewer twice with different system prompts (security-focused pass, then architecture-focused pass) rather than different models

#### 50. Proactive work finding

The OpenClaw orchestrator (Zoe) finds work proactively: morning Sentry scan → spawn bug-fix agents, post-meeting note scan → spawn feature agents, evening git log scan → spawn docs agents. Case is entirely reactive — humans create tasks. **Action:** With the orchestrator (#40), add proactive triggers:

- **CI failure on main** → auto-create a bug-fix task with the failure context
- **Dependency update available** → auto-create an update task (low-risk, unattended candidate)
- **Stale docs detected** (#45) → auto-create a cleanup task
- **PR merged** → auto-trigger retrospective (already partially done via post-PR hook)

Start conservative: auto-create tasks but require human approval before starting the pipeline. Graduate to auto-start for well-understood task types (dependency updates, doc cleanup).

### Key takeaways

**From Mission Control:** Memory is a stack, not a single layer. Case needs working memory (per-task state that survives across sessions) and a run log (cross-task timeline for pattern detection).

**From Guo's Playbook:** JSON for state, Markdown for knowledge. Decompose before implementing. Scan for staleness automatically. Design for both attended and unattended modes.

**From OpenClaw Swarm:** Context is zero-sum — specialize what each agent sees. Retry intelligently, not identically. Find work proactively instead of waiting for humans.

---

## Learnings from "Self-Improving Skills for Agents" (cognee-skills) ([Readwise](https://readwise.io/reader/shared/01kkpb9nhbr03shkh1fyv5t63g))

cognee-skills implements a closed-loop system treating agent skills as living components. Five-stage cycle: Ingest (semantic enrichment, graph storage) → Observe (capture outcomes per execution) → Inspect (correlate across runs via graph relationships) → Amend (evidence-based prompt modification with `.amendify()`) → Evaluate (measure against baseline, rollback on regression). All amendments tracked with rationale and version history.

### What Case already does well (validated)

- **Observe stage.** Case's retrospective reads progress logs and captures outcomes. Same intent as cognee's observation layer.
- **Amend stage.** Retrospective already modifies agent prompts and appends learnings. The amendify concept maps to what retrospective does today.
- **Version tracking intent.** Item #30 (agent prompt versioning) already describes the right goal.

### What Case should steal

#### 54. Prompt snapshots for one-step rollback

cognee tracks every skill amendment with evidence + result and rolls back if metrics regress. All previous versions remain loadable — rollback is one operation. Case's #30 says "flag for human review, don't auto-revert," but doesn't preserve the prior version in a loadable format. Git history exists, but finding the right commit to revert an agent prompt is archaeology, not operations. **Action:** When retrospective modifies an agent prompt:

1. Copy the current version to `docs/agent-versions/{agent}-{date}.md`
2. Record alongside it: which metrics motivated the change, which task triggered it
3. If next run's metrics regress, the orchestrator (#40) can load the snapshot directly

This turns prompt rollback from "dig through git log" to "load previous snapshot." Combined with #30's changelog, you get full provenance: what changed, why, whether it helped, and a one-step undo.

#### 55. Relational fields in run log schema

cognee stores execution history as a graph — runs are nodes with typed relationships to skills, tasks, prior runs, and amendments. This enables queries like "which prompt version was active when repo X started failing?" or "does skill Y degrade when preceded by pattern Z?" Case's planned JSONL run log (#42) is flat: one entry per run, append-only. Flat logs support sequential analysis ("last 10 runs") but not relational queries. **Action:** Add relationship fields to the run log entry schema:

```json
{
  "runId": "uuid",
  "date": "2026-03-14",
  "task": "cli-2-one-shot-mode",
  "repo": "cli",
  "promptVersions": {
    "implementer": "v3-2026-03-10",
    "verifier": "v2-2026-03-01"
  },
  "priorRunId": "uuid-of-previous-run-on-same-task",
  "parentTaskId": "ideation-contract-id-if-applicable",
  "outcome": "completed",
  "phases": { "implementer": "pass", "verifier": "pass" },
  "metrics": { "ciFirstPush": true, "reviewFindings": { "critical": 0 } }
}
```

`promptVersions` links runs to prompt snapshots (#54). `priorRunId` enables retry-chain analysis. `parentTaskId` connects to ideation contracts. Retrospective can now answer "did the last prompt change improve CI first-push rate?" without manually correlating dates.

### Key takeaway

> Skills degrade silently. The value isn't in the improvement cycle itself — it's in making degradation visible and rollback cheap.

Case's retrospective already has the right intent. What's missing is the infrastructure to detect regression (relational run logs) and recover from it (prompt snapshots). Items 54-55 close that gap.

---

## Learnings from "Skill Issue: Harness Engineering for Coding Agents" ([Blog: HumanLayer](https://www.humanlayer.dev/blog/skill-issue-harness-engineering-for-coding-agents))

Practical guide to harness configuration surfaces. Defines harness engineering (coined by Viv Trivedy) as "anytime you find an agent makes a mistake, you take the time to engineer a solution such that the agent never makes that mistake again." Covers CLAUDE.md, MCP servers, Skills, Sub-agents, and Hooks as the five configuration surfaces. Cites ETH Zurich research and Chroma context degradation studies.

### What Case already does well (validated)

- **Hooks as deterministic control flow.** The article describes hooks as the mechanism for approval/denial logic and verification loops. Case's pre-commit, pre-push, and pre-PR hooks are exactly this pattern.
- **Sub-agents as context firewalls.** "Isolate discrete tasks in separate context windows so intermediate noise doesn't accumulate." Case's worktree-per-agent isolation achieves the same result. The article adds that Chroma research confirms performance degrades as context lengthens — validating Case's agent separation.
- **Progressive disclosure via skills.** "Allow agents to access specific instructions only when needed." Case's SKILL.md → docs/ layering is this pattern.
- **Back-pressure through verification.** "Your likelihood of successfully solving a problem with a coding agent is strongly correlated with the agent's ability to verify its own work." Validates the verifier phase as architecturally essential, not optional.
- **"The model is probably fine. It's just a skill issue."** Directly echoes Case's philosophy: "When agents struggle, fix the harness."

### What Case should steal

#### 51. Human review gate for retrospective amendments (IMPORTANT)

The ETH Zurich study found that auto-generated CLAUDE.md/agent files _hurt_ performance while consuming 20%+ more tokens. Human-curated files helped ~4%, but auto-generated ones were net negative. Case's retrospective currently modifies agent prompts and learnings files directly — no review step. **Action:** Change retrospective from "edit in place" to "propose and stage":

1. Retrospective writes proposed amendments to a staging area (e.g., `docs/proposed-amendments/`)
2. Each amendment includes: what to change, which metrics motivated it, which task triggered it
3. Human reviews and promotes (moves to agent prompt) or rejects (deletes)
4. Only after promotion does the change take effect in the next run

This doesn't slow down the pipeline — retrospective still runs automatically. It adds a quality gate between "retrospective thinks X should change" and "X actually changes." The ETH Zurich data is clear: unsupervised prompt modification is net negative. Combined with #54 (snapshots), rejected amendments still have value as a record of what the system considered changing.

#### 52. Success-is-silent output rule

The article states a design principle for hooks: "Success is silent; only failures produce verbose output to avoid context pollution." Case's scripts and hooks currently emit output on both success and failure. `check.sh` prints all 47 passing checks alongside the 2 failures. Every "PASS: ..." line enters the agent's context window, competes for attention, and contributes nothing actionable. **Action:** Apply a universal rule to all agent-facing output:

- **Success:** emit nothing, or a single-line summary ("47/49 checks passed")
- **Failure:** emit full diagnostics with remediation hints (#34)
- **Scripts:** `check.sh`, `session-start.sh`, `pre-pr-check.sh` — refactor to suppress passing items
- **Hooks:** pre-commit, pre-push — only produce output when blocking

This complements #37 (pre-filter script output) with a concrete, universal rule. The distinction matters: #37 says "filter to what's relevant." #52 says "passing results are never relevant." Simpler rule, easier to enforce, directly reduces context waste.

#### 53. Per-agent tool profiles as correctness requirement

The article warns: "Too many tools push agents into the dumb zone faster by bloating context." Tool descriptions are injected into system prompts. Every unused MCP tool wastes tokens and — per the article — actively degrades reasoning quality, not just efficiency. Case currently exposes all available MCP tools to every agent phase. Item #16 (curated tool subsets) framed this as an optimization. The HumanLayer article reframes it as correctness: **excess tools degrade the quality of agent reasoning.** **Action:** Define per-agent tool profiles as a hard requirement, not an optimization:

- **Implementer:** file I/O, bash, git, grep, glob. No PR tools, no review tools, no MCP servers for external services.
- **Verifier:** file I/O, bash (for test execution), browser tools (Playwright). No edit tools (already enforced). No git push.
- **Reviewer:** file read, grep, glob, git diff. No edit, no bash (beyond git), no MCP.
- **Closer:** git, gh CLI, file read. No edit, no bash beyond git/gh.

The article also recommends preferring existing CLIs over MCP servers: "GitHub CLI, Docker CLI, database CLIs — these compose with `grep`, `jq`, and are battle-tested." Only add MCP servers when no CLI equivalent exists.

#### 56. Two-tier test verification

The article recommends: "Make verification context-efficient. Running full test suites floods context; instead swallow output and surface only errors." Case's verifier runs the full test suite for every verification. For large repos, this wastes context on passing tests and slows the feedback loop. **Action:** Implement two-tier verification:

1. **Tier 1 (fast, <30 sec):** Run tests related to changed files only. Use test runner's `--related` or `--changed` flags (vitest supports `--related`). Swallow output; surface only failures.
2. **Tier 2 (full, only if Tier 1 passes):** Run the complete test suite. Still swallow passing output — only failures enter context.

If Tier 1 catches a failure, the implementer can fix it immediately without waiting for the full suite. If Tier 1 passes but Tier 2 fails, the failure is in an unexpected dependency — more informative than a flat "tests failed." This directly implements the article's verification back-pressure principle and reinforces #19 (shift feedback left).

### Anti-patterns validated

The article identifies anti-patterns that Case should explicitly avoid:

- **Designing ideal harness configurations preemptively.** Case's 50-item improvement list risks this. Execute wave-by-wave; don't architect ahead.
- **Installing tools "just in case."** Only add MCP servers, skills, or tools when a real failure motivates them.
- **Running full test suites at every agent stop.** Run targeted subsets (reinforces #56).

### Post-training overfitting note

The article reports that Claude Opus ranks #33 in Claude Code but #5 in a different harness not seen during training. Models couple to their training harness. This is relevant to #49 (multi-model review): when Case optimizes prompts for Claude, it may inadvertently exploit Claude-specific behaviors that other models don't share. If Case ever supports multiple models, prompt effectiveness may vary significantly by model — another reason for prompt versioning (#30) with per-model metrics.

### Key takeaway

> "The model is probably fine. It's just a skill issue." — When agents underperform, examine the harness before blaming the model.

Case's most actionable takeaway is #51: **stop letting retrospective edit agent prompts unsupervised.** The ETH Zurich data is unambiguous — auto-generated agent instructions are net negative. Add a human review gate. The second priority is #52: scripts should shut up when things pass. Every line of "PASS" output is context the agent must process and discard.

---

## Learnings from autoresearch ([GitHub: karpathy/autoresearch](https://github.com/karpathy/autoresearch))

Karpathy's autonomous research framework: an agent modifies `train.py`, runs a 5-minute training experiment, checks if `val_bpb` (validation bits per byte) improved, keeps or discards (git reset), and loops forever. The human iterates on `program.md` (the harness instructions), never the code. Three files, one metric, one loop. Deliberately minimal — the simplicity is the point.

### What Case already does well (validated)

- **"Program the program, not the code."** autoresearch's README: "You are programming the `program.md` Markdown files that provide context to the AI agents." This is Case's philosophy — "humans steer, agents execute" — stated as literal architecture. The human's deliverable is the harness. The agent's deliverable is the code.
- **Structured results logging.** autoresearch logs every experiment to `results.tsv` with: commit, metric, memory, status (keep/discard/crash), description. Case's planned run log (#42) serves the same purpose. Validated.
- **Autonomous unattended operation.** autoresearch's "NEVER STOP" instruction — the agent loops until interrupted — validates Case's unattended mode design (#46). The human may be asleep. The agent keeps working.
- **Crash triage.** "If it's dumb and easy to fix, fix and re-run. If fundamentally broken, skip and move on." Two explicit paths. Case's doom loop detector approximates this, though less explicitly.

### What Case should steal

#### 57. Output redirection pattern

autoresearch's experiment loop step 4-5:

```bash
uv run train.py > run.log 2>&1        # step 4: redirect everything
grep "^val_bpb:\|^peak_vram_mb:" run.log  # step 5: extract only metrics
```

The agent **never sees the training output.** Hundreds of lines of step-by-step loss values, timing data, and compilation messages are redirected to a file. The agent reads exactly 2 lines via grep. This is items #37 (pre-filter) and #52 (success-is-silent) implemented as a concrete, copy-pasteable pattern. **Action:** Change implementer and verifier to redirect command output to files and grep for results:

- Test runs: `uv run vitest run > test.log 2>&1` then `grep -E "^(FAIL|Tests)" test.log`
- Lint: `eslint . > lint.log 2>&1` then `grep -c "error" lint.log` (zero = pass, skip entirely)
- Typecheck: `tsc --noEmit > tsc.log 2>&1` then `tail -1 tsc.log` (only the summary line)
- Build: `npm run build > build.log 2>&1` then check exit code, only read log on failure

Add this pattern to the implementer prompt as an explicit instruction: "Always redirect command output to a log file. Read the log file with grep for specific results. Never let raw command output enter your context." This is the single cheapest context-saving change — it requires no infrastructure, just a prompt edit.

#### 58. Keep/discard binary discipline

autoresearch's core loop: if `val_bpb` improved → keep the commit. If equal or worse → `git reset`. No "it's kind of better." No "some tests pass now but others broke." Binary. The branch only advances on measurable improvement.

Case's implementer doesn't have this discipline. It commits code, discovers some tests broke, tries to fix them forward, sometimes makes things worse, potentially doom-loops. Each "fix" can create new breaks, compounding the mess. **Action:** Add keep/discard discipline to the implementer:

1. Before implementing, capture the current state: `vitest run --reporter=json > baseline.json 2>&1`
2. Implement the change, commit
3. Run tests again: `vitest run --reporter=json > attempt.json 2>&1`
4. Compare: did the target metric improve? (failing test now passes, no new failures)
5. If yes → keep the commit, continue
6. If no → `git reset --hard HEAD~1`, log the attempt in working memory (#41) as "tried X, didn't work", try a different approach

This prevents the compounding mess where each forward-fix creates new breaks. It also produces a natural experiment log: "tried approach A (reverted), tried approach B (reverted), approach C worked." Combined with working memory (#41), this gives the next retry session a map of what was already tried.

The key insight from autoresearch: **reverting a failed attempt is not a failure — it's data.** The agent learns what doesn't work without accumulating technical debt from half-working fixes.

#### 59. Machine-checkable success condition per task

autoresearch has one metric: `val_bpb`. Lower is better. The agent checks it after every experiment with a single grep command. No ambiguity about whether progress was made.

Case tasks have acceptance criteria in prose. The implementer interprets them, writes code, then the verifier checks — but there's no single, automatically measurable condition the implementer can check mid-implementation. **Action:** Add a `check_command` field to task files:

```json
{
  "check_command": "vitest run src/session/__tests__/refresh.test.ts --reporter=json 2>&1 | jq '.testResults[0].numPassedTests'",
  "check_baseline": 3,
  "check_target": 5
}
```

The implementer runs `check_command` after each attempt. If the number went from baseline toward target, keep. If not, discard (#58). This makes the keep/discard decision automatic and removes ambiguity.

For bug fixes, the check is often simple: "does the failing test pass?" For features, it's the acceptance test count. For refactors, it might be "all existing tests still pass." The point is that it's a command, not prose — the agent can run it and get a number.

This connects to #44 (initializer decomposition) but is more fundamental: decomposition produces many checkable items, but even without decomposition, every task should have at least one machine-checkable success condition.

#### 60. Explicit simplicity criterion in agent prompts

From `program.md`:

> All else being equal, simpler is better. A small improvement that adds ugly complexity is not worth it. Conversely, removing something and getting equal or better results is a great outcome — that's a simplification win.
>
> A 0.001 val_bpb improvement that adds 20 lines of hacky code? Probably not worth it. A 0.001 val_bpb improvement from deleting code? Definitely keep.

Case's CLAUDE.md says "avoid over-engineering" but the implementer prompt doesn't quantify the tradeoff. The agent doesn't know when a fix is too complex relative to the problem. **Action:** Add an explicit simplicity criterion to the implementer prompt:

- "If your fix adds more than 3x the lines needed to solve the stated problem, simplify before committing."
- "If you can delete code and tests still pass, that's a win — commit the deletion."
- "A 5-line fix for a 1-line bug is acceptable. A 50-line fix for a 1-line bug means you're solving the wrong problem."

This gives the agent a concrete heuristic for the complexity/value tradeoff. It also provides a natural gate for #31 (domain-specific evaluators): diff size vs task complexity is measurable, and the simplicity criterion makes it an in-agent check rather than a post-hoc evaluation.

### The meta-lesson

autoresearch's entire harness is 115 lines of Markdown in `program.md`. No orchestrator. No metrics pipeline. No prompt versioning system. It works because the scope is ruthlessly constrained: one file, one metric, one loop.

Case's 60-item improvement list is the opposite extreme. The risk isn't that any individual item is wrong — most are good ideas — but that the harness itself becomes over-engineered. autoresearch is a reminder that the core loop — **try, measure, keep/discard, repeat** — is what matters. Everything else is optimization on top of that loop.

The practical implication: if Case adopted only items #57 (output redirection), #58 (keep/discard), and #59 (checkable success condition), the implementer would immediately become more effective. Those three changes require no infrastructure — just prompt edits and a task template field. Start there.

### Key takeaway

> The simplest harness that captures the core loop — try, measure, keep/discard, repeat — often outperforms a sophisticated one. Complexity in the harness is subject to the same tradeoff as complexity in code: it must earn its place.
