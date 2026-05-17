# Case

<img width="500" height="500" alt="Case" src="docs/case-logo.svg" />

Case is the reliability layer for agent-authored WorkOS OSS pull requests.

Its job is narrow: turn a clearly scoped WorkOS OSS task into a reviewed PR with evidence, and make the next run better when this one fails. Case is not a generic agent platform, a dashboard product, or a place to accumulate every possible workflow idea. Humans steer. Agents execute. The harness keeps the work reviewable.

## Why It Exists

Agents are useful when the surrounding system makes good work easier than bad work. Case provides that surrounding system for the WorkOS open source repos:

- A shared map of target repos, commands, architecture notes, and conventions.
- A task format that separates human intent from machine-updated state.
- A small multi-agent pipeline with isolated responsibilities.
- Evidence gates for tests, manual verification, review, and PR creation.
- Retrospective learning so repeated failures become docs, playbooks, or enforcement.

The north star:

> Case exists to make agent-authored WorkOS OSS PRs reliable, reviewable, and self-improving.

## Core Loop

From a target repo:

```bash
ca 1234
```

Case detects the repo, fetches the GitHub issue, creates task files, runs a baseline check, and dispatches the pipeline:

```text
implementer -> verifier -> reviewer -> closer -> retrospective
```

For unclear work, use the human steering path:

```bash
ca --agent
ca --agent 1234
```

`ca --agent` starts an interactive orchestrator session. It can inspect context, fetch issues, help shape the task, create the task file, and then run the pipeline. It should not implement directly. This is the primary interface for “humans steer.”

For an existing task file:

```bash
ca run --task .case/tasks/active/cli-1-issue-53.task.json
```

To resume an interrupted issue run, re-run the same command:

```bash
ca 1234
```

Case reuses the existing task when it finds one and resumes from stored state.

## What Belongs

Case should stay focused on the PR loop. A feature belongs when it does at least one of these:

- Makes `ca <issue>` or `ca --agent <issue>` more likely to produce a correct PR.
- Converts an observed agent failure into a repeatable guardrail.
- Preserves context isolation, evidence, or resumability.
- Can be tested hermetically without depending on one user's machine.

Current non-goals:

- Generic agent platform features.
- Local dashboards and webhook services.
- Human approval browser UI between pipeline phases.
- Specialized reviewer fleets.
- Ideation/spec execution as a first-class runtime.

Those ideas may be revisited only after the core PR loop is boringly reliable.

## Setup

Requires [Bun](https://bun.sh) >= 1.0.

```bash
bun install
bun link
ca init
```

`ca init` creates `~/.config/case/` and migrates local state from the repo when run from the case checkout. Re-running it is safe.

Build a standalone binary:

```bash
bun run build:binary
cp dist/ca /usr/local/bin/ca
```

`build:binary` regenerates the embedded package asset manifest before compiling. The resulting `dist/ca` is portable: agent prompts, docs, playbooks, and AST rules are bundled into the executable. The binary is `ca` because `case` is a reserved word in bash and zsh.

## CLI

Primary commands:

```bash
ca 1234                 # create or resume a GitHub issue run
ca DX-1234              # create or resume a Linear issue run
ca --agent              # interactive steering session
ca --agent 1234         # steering session with issue context
ca run --task <file>    # run an existing task JSON
ca watch <task-slug>    # live-tail the event log
```

Agent-facing commands:

```bash
ca session <repo-path> --task <task.json>
ca status <task.json> [field value...]
ca mark-tested
ca mark-manual-tested
ca mark-reviewed --critical 0
ca upload <file>
ca snapshot <agent-name>
ca create --repo <name> --title <title> --description <text>
ca analyze-failure <task.json> <agent> <error>
ca bootstrap <repo>
ca check [--repo <repo>]
```

Common flags:

```bash
ca --model claude-opus-4-5 1234
ca run --task <file> --mode unattended
ca run --task <file> --dry-run
ca run --fresh 1234
```

## Storage Layout

Package-level config lives under `~/.config/case/`. Per-repo runtime state lives under each target repo's ignored `.case/` directory:

```text
~/.config/case/
  config.json
  projects.json
  agent-versions/

<target-repo>/.case/
  active
  learnings.md
  amendments/
  run-log.jsonl
  tasks/
    active/
      <task-slug>.md
      <task-slug>.task.json
  <task-slug>/
    events/
    plan.json
```

Override the config/cache directory with:

```bash
CASE_DATA_DIR=/tmp/case-test ca init
```

Static package assets are versioned with Case and embedded into the standalone binary: `agents/`, markdown under `docs/`, and text rules under `ast-rules/`. When running from a checkout, disk files win so local prompt/doc edits are picked up immediately; set `CASE_PACKAGE_ROOT=/path/to/case` to force a specific checkout as the disk override.

For portable binary installs, keep `projects.json` in `~/.config/case/` via `ca init --projects <path>` or `ca init --migrate-from <case-checkout>`. Repo paths in a portable `projects.json` should be absolute or relative to that `projects.json` file.

## Pipeline

The runtime uses a deterministic TypeScript DAG executor for phase transitions. The LLMs do the work inside each phase; TypeScript decides which phase runs next.

Profiles:

- `standard`: implement, verify, review, close, retrospective.
- `tiny`: implement, review, close, retrospective. Use only for docs, typos, and mechanical config changes where independent verification is not useful.

Revision loops are evaluator-driven. A verifier or reviewer rubric failure can send structured feedback back to the implementer. The default revision budget is two cycles.

Every run writes an append-only event log under `<target-repo>/.case/<task-slug>/events/`. `ca watch <task-slug>` renders those events while a run is active.

## Agent Roles

| Agent         | Responsibility                                                       | Does Not Do                         |
| ------------- | -------------------------------------------------------------------- | ----------------------------------- |
| Orchestrator¹ | Parses issues, creates tasks, runs baseline, dispatches the pipeline | Implement code                      |
| Implementer   | Writes the fix, runs automated tests, commits                        | Manual browser testing, PR creation |
| Verifier      | Tests the specific user-facing scenario and records evidence         | Edit code                           |
| Reviewer      | Reviews the diff against golden principles and conventions           | Edit code or create PRs             |
| Closer        | Creates the PR after evidence gates pass                             | Implement or test                   |
| Retrospective | Records learnings and proposes harness improvements                  | Edit target repo code               |

¹ The orchestrator is TypeScript runtime code (`src/agent/orchestrator-session.ts`), not an LLM agent prompt like the others.

The key boundary is context isolation. Implementer context includes task details, playbooks, repo learnings, and revision feedback. Verifier context is intentionally fresher. Reviewer context is focused on the diff and principles.

## Evidence Gates

Evidence markers live under the target repo's `.case/<task-slug>/` directory:

- `tested`: created by `ca mark-tested` from real test output.
- `manual-tested`: created by `ca mark-manual-tested` from manual/browser verification evidence.
- `reviewed`: created by `ca mark-reviewed --critical 0`.

The closer checks these markers before opening a PR. The point is not ceremony; it is making the PR auditable without trusting a chat transcript.

## Self-Improvement

After a run, the retrospective agent should leave the harness smarter:

- Append tactical repo learnings under `<target-repo>/.case/learnings.md`.
- Propose broader harness changes under `<target-repo>/.case/amendments/`.
- Escalate repeated failures into docs, playbooks, conventions, or enforcement.

Retrospective output is constrained. It should not expand the product surface by default. The fix for repeated agent failure is usually a clearer task, a better playbook, a sharper convention, or a mechanical guardrail.

## Model Configuration

Configure models in `~/.config/case/config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/workos/case/main/config.schema.json",
  "models": {
    "default": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
    "reviewer": { "provider": "google", "model": "gemini-2.5-pro" },
    "verifier": null
  }
}
```

Priority:

```text
--model flag > explicit spawn options > config file > hardcoded default
```

## Repository Map

Target repos are listed in `projects.json`.

| Repo                   | Path                        | Purpose                               |
| ---------------------- | --------------------------- | ------------------------------------- |
| cli                    | `../cli/main`               | WorkOS CLI                            |
| skills                 | `../skills`                 | WorkOS integration skills             |
| authkit-session        | `../authkit-session`        | Framework-agnostic session management |
| authkit-tanstack-start | `../authkit-tanstack-start` | AuthKit TanStack Start SDK            |
| authkit-nextjs         | `../authkit-nextjs`         | AuthKit Next.js SDK                   |
| workos-node            | `../workos-node/main`       | WorkOS Node.js SDK                    |

Add a repo by updating `projects.json`, adding any needed architecture notes under `docs/architecture/`, and verifying with:

```bash
ca check --repo <name>
```

## Development Checks

For case itself:

```bash
bun run typecheck
bun test ./src/__tests__/
bun run lint
bun run format:check
```

For target repos:

```bash
ca bootstrap <repo>
ca check --repo <repo>
```

## Philosophy

The short version:

- Humans steer. Agents execute.
- The harness is the product; target repo code is the output.
- When agents struggle, fix the harness.
- Enforce mechanically, not rhetorically.
- Test the specific fix, not the happy path.
- Keep the tool small unless reliability demands complexity.

See [docs/philosophy.md](docs/philosophy.md) for the fuller version.
