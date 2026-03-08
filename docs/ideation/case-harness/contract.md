# Case Harness Contract

**Created**: 2026-03-07
**Confidence Score**: 95/100
**Status**: Approved
**Architecture**: Spine/meta-repo pattern

## Problem Statement

WorkOS maintains ~25 open source repositories (SDKs across 8 languages, AuthKit integrations for 6+ frameworks, CLI, skills plugin) that share conventions, patterns, and architectural decisions — but no single repo captures the cross-cutting knowledge. An agent working in `authkit-nextjs` doesn't know how the CLI is structured, what patterns `authkit-session` uses, or what conventions are shared across the ecosystem.

Every agent session starts cold. There's no onboarding material for agent "teammates," no playbooks for recurring cross-repo operations, and no way to dispatch agent work in parallel across repos. The human engineer ends up as the bottleneck — steering every session manually, repeating context, and catching inconsistencies by hand.

The goal is to adopt harness engineering: build the environment so that agents can operate reliably across the WorkOS OSS ecosystem with minimal human steering. "Humans steer. Agents execute." When an agent struggles, the fix is never "try harder" — it's "what's missing from the harness?"

## Goals

1. **Cross-repo agent effectiveness** — An agent given a task file can navigate to the target repo(s) and produce a correct, test-passing PR using harness docs alone, without additional human guidance.
2. **Task-file dispatch** — An engineer writes a task file in `tasks/active/`, an agent picks it up and executes. Multiple task files = multiple agents in parallel. No custom runtime needed.
3. **Never write code directly** — Engineers only improve the harness (docs, playbooks, conventions, enforcement, task templates). All code changes flow through agents.
4. **Pattern consistency** — Shared conventions are documented once in `case/` and enforced mechanically via linters and check scripts. Agents replicate good patterns, not bad ones.
5. **Plugin-based context injection** — `case` is a Claude Code plugin providing a `/case` skill, so any agent in any target repo gets harness context automatically.
6. **Scalable to 25 repos** — v1 targets 5 repos, but all artifacts (manifest schema, playbook format, task routing, AGENTS.md structure) are designed to scale to the full WorkOS OSS ecosystem.

## Success Metrics

**Quantitative (tracked over time):**
- **First-pass PR success rate** — % of agent PRs that pass CI and are mergeable without human code edits. Target: >70% within 4 weeks.
- **Human interventions per task** — average number of times the engineer has to course-correct an agent mid-task. Target: <2 per task.
- **Task-to-PR time** — elapsed time from task file creation to PR opened. Baseline TBD after first 10 tasks.

**Qualitative (pass/fail):**
- [ ] An agent given `tasks/active/cli-*.md` produces a correct, test-passing PR in `../cli/main`
- [ ] An agent given `tasks/active/authkit-*.md` produces a reviewable PR in the target AuthKit repo
- [ ] `AGENTS.md` routes agents to the correct repo, playbook, and conventions for any task across the 5 v1 repos
- [ ] Each of the 5 v1 repos has an AGENTS.md (or upgraded CLAUDE.md) that meets the per-repo standard
- [ ] Project manifest contains accurate metadata for all 5 repos and is schema-valid
- [ ] Architecture docs capture canonical patterns: CLI command structure, AuthKit framework integration, session management, skills plugin structure
- [ ] Golden principles are encoded and enforced via `scripts/check.sh` across all 5 repos
- [ ] Playbooks exist for: add CLI command, add AuthKit framework, fix a bug, cross-repo update
- [ ] Task templates exist for each playbook type
- [ ] `case` is installable as a Claude Code plugin providing a `/case` skill
- [ ] Required check suite per repo: lint, typecheck, test, build — all documented and runnable by agents

## Scope Boundaries

### In Scope

**V1 Target Repos (5):**
- `../cli/main` — WorkOS CLI (TypeScript, pnpm)
- `../skills` — Claude Code plugin for WorkOS skills (TypeScript, pnpm)
- `../authkit-session` — Framework-agnostic session management (TypeScript, pnpm)
- `../authkit-tanstack-start` — AuthKit TanStack Start SDK (TypeScript, pnpm)
- `../authkit-nextjs` — AuthKit Next.js SDK (TypeScript, pnpm)

**Spine (case/ repo):**
- `AGENTS.md` — workspace-level navigation/routing (~100 lines, map not manual)
- `docs/architecture/` — canonical patterns for each repo type
- `docs/conventions/` — shared rules (commits, testing, PRs, linting, file size limits)
- `docs/golden-principles.md` — invariants enforced across all repos
- `docs/playbooks/` — step-by-step task templates for recurring operations
- `projects.json` — manifest of all target repos (path, language, pm, commands), schema designed for 25+
- `scripts/check.sh` — cross-repo convention enforcement (runs golden principle checks)
- `scripts/bootstrap.sh` — per-repo setup verification (deps installed, tests pass, build works)

**Task System:**
- `tasks/active/` — current task files for agent execution
- `tasks/done/` — completed tasks (moved after PR merge)
- `tasks/templates/` — reusable task templates per playbook type
- Naming convention: `{repo}-{n}-{slug}.md` for single-repo, `x-{n}-{slug}.md` for cross-repo

**Per-Repo AGENTS.md (first-class deliverable):**
- Create or upgrade AGENTS.md in each of the 5 v1 repos
- Standard sections: do/don't rules, commands (lint/test/typecheck/build), project structure, PR checklist, patterns to follow/avoid
- Each repo's AGENTS.md is self-sufficient — an agent landing in that repo alone can do competent work

**Plugin Infrastructure:**
- Claude Code plugin structure (`.claude-plugin/`)
- `/case` skill that loads harness context (landscape, conventions, relevant playbook) based on task description
- Dependency on `skills` plugin for WorkOS domain knowledge

**Golden Principles + Enforcement:**
- Documented invariants (naming conventions, boundary validation, file size limits, structured logging)
- `scripts/check.sh` validates adherence across repos
- Lint error messages include remediation instructions (agent reads how to fix directly from error output)

### Out of Scope

- Backend SDKs (workos-node, workos-python, workos-go, etc.) — v2 expansion, but manifest/playbook schemas accommodate them
- `case run` CLI / Agent SDK runtime — future, task files provide dispatch without custom tooling
- Planner/executor dual-agent architecture — future complexity
- Self-healing CI pipelines — future, requires more infrastructure
- Automated GitHub issue triage — future, requires webhook integration
- Browser automation (Playwright/DevTools MCP) — future tooling layer
- WorkOS CLI integration for API access — future tooling layer
- Cross-repo dashboards or quality scorecards — future observability
- Agent-to-agent review workflows — future, humans review in v1

### Future Considerations

- Expand to all ~25 repos (backend SDKs, additional AuthKit frameworks)
- `case run` command using Agent SDK or Claude Code headless for parallel dispatch
- GitHub webhook → agent triage → PR pipeline
- Recurring "garbage collection" agents (audit conventions, fix drift, open refactoring PRs)
- Planner agent that decomposes cross-repo tasks into per-repo subtasks automatically
- Self-healing CI that auto-diagnoses failures and opens fix PRs
- Quality scorecards per repo tracked over time
- Integration with Linear for issue tracking
- 30/60/90 "onboarding plans" for new repos joining the harness
- Model routing — lighter models for simple tasks, frontier for complex implementation
- Tiered autonomy with ideation-as-planner — sub-agent runs ideation for novel tasks, answers questions from harness context, escalates to human when confidence < 85
- Task templates for common operations bypass ideation entirely (template IS the spec)

## Execution Plan

### Dependency Graph

```
Phase 1: Spine Foundation
  ├── Phase 2: Per-Repo AGENTS.md     (blocked by 1, parallel with 3)
  ├── Phase 3: Knowledge Base          (blocked by 1, parallel with 2)
  │     ├── Phase 4: Playbooks + Tasks (blocked by 3, parallel with 5)
  │     └── Phase 5: Enforcement       (blocked by 3, parallel with 4)
  └── Phase 6: Plugin Infrastructure   (blocked by 1, 3, 4)
```

### Execution Steps

**Strategy**: Hybrid — sequential start, then parallel groups.

1. **Phase 1** — Spine Foundation _(blocking, must complete first)_
   ```bash
   /execute-spec docs/ideation/case-harness/spec-phase-1.md
   ```

2. **Phases 2 & 3** — parallel after Phase 1
   ```bash
   /execute-spec docs/ideation/case-harness/spec-phase-2.md
   /execute-spec docs/ideation/case-harness/spec-phase-3.md
   ```

3. **Phases 4 & 5** — parallel after Phase 3
   ```bash
   /execute-spec docs/ideation/case-harness/spec-phase-4.md
   /execute-spec docs/ideation/case-harness/spec-phase-5.md
   ```

4. **Phase 6** — Plugin Infrastructure _(blocked by 1, 3, 4)_
   ```bash
   /execute-spec docs/ideation/case-harness/spec-phase-6.md
   ```

### Agent Team Prompt

For steps 2 and 3, use delegate mode (Shift+Tab) to run phases in parallel:

```
You are coordinating the Case Harness build. Run these phases in parallel using teammates.

## Teammate 1: Per-Repo AGENTS.md
Execute spec: docs/ideation/case-harness/spec-phase-2.md
Create or upgrade AGENTS.md in each of the 5 target repos:
- ../cli/main
- ../skills
- ../authkit-session
- ../authkit-tanstack-start
- ../authkit-nextjs
Read each repo deeply before writing its AGENTS.md.

## Teammate 2: Knowledge Base
Execute spec: docs/ideation/case-harness/spec-phase-3.md
Build the docs/ knowledge base in case/:
- docs/architecture/ (cli, authkit-framework, authkit-session, skills-plugin)
- docs/conventions/ (commits, testing, PRs, code-style)
- docs/golden-principles.md

Coordinate: Teammate 2 writes docs/architecture/ files that Teammate 1 may reference in
per-repo AGENTS.md files. If Teammate 1 needs architecture context, they should read the
target repo directly rather than waiting for Teammate 2's docs.

After both teammates complete, review all artifacts for cross-references and consistency.
```

For step 3 (Phases 4 & 5), use a similar prompt:

```
You are coordinating the Case Harness build (phases 4 & 5). Run in parallel.

## Teammate 1: Playbooks + Task System
Execute spec: docs/ideation/case-harness/spec-phase-4.md
Build playbooks in docs/playbooks/ and task templates in tasks/templates/.
References docs/architecture/ and docs/conventions/ (from Phase 3).

## Teammate 2: Enforcement Scripts
Execute spec: docs/ideation/case-harness/spec-phase-5.md
Build scripts/check.sh and scripts/bootstrap.sh.
References docs/golden-principles.md and projects.json.

No shared files — these can run fully independently.
```
