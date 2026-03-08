# Harness Philosophy

Principles that guide how case is built and used. These come from experience, from the OpenAI harness engineering post, and from Ryan Lopopolo's talk.

## Core

- **Humans steer. Agents execute.** Engineers define goals and acceptance criteria. Agents implement.
- **Never write code directly.** All code changes flow through agents. Engineers only improve the harness.
- **When agents struggle, fix the harness.** The fix is never "try harder" — it's a missing doc, playbook, convention, or enforcement rule.
- **The harness is the product. The code is the output.**

## Context & Documentation

- **Give a map, not a manual.** Short, stable entry points. Agents drill deeper only when needed. AGENTS.md is ~50 lines.
- **Progressive disclosure.** Don't dump everything into context up front. Route to the right doc based on the task.
- **The fix is never "try harder."** When something fails, ask: what capability is missing, and how do we make it legible and enforceable for the agent?

## Enforcement

- **Instructions decay, enforcement persists.** Agents forget instructions over long sessions. Hooks and linters don't forget.
- **Human taste is captured once, enforced continuously.** Encode preferences into linters, hooks, and golden principles rather than repeating review comments.
- **Enforce mechanically, not rhetorically.** "STOP — do this before proceeding" doesn't work. A hook that blocks `gh pr create` does.

## Testing & Verification

- **Test the specific fix, not the happy path.** Ask: "if I reverted my change, would this test fail?" If no, you're testing the wrong thing.
- **Corrections are cheap, waiting is expensive.** In high-throughput agent environments, fix forward rather than blocking indefinitely.

## Task Management

- **Queue work, don't micromanage.** Dispatch a task, walk away, review the PR. Don't shoulder-surf.
- **Like managing 50 interns.** Success is judged on their productivity, not yours.
- **The task file is the communication channel.** Not chat, not draft PRs on public repos.

## Architecture

- **Models replicate existing patterns.** If the codebase has good patterns, agents replicate them. If it has bad patterns, they replicate those too. The harness selects which patterns to follow.
- **Getting architecture wrong is expensive.** High code production rate amplifies bad patterns. Some refactoring becomes impossible.
- **Pattern consistency is what makes agents effective at scale.** Same shapes, same conventions, same structure across repos.

## Evolution

- **Don't build tooling for pain you haven't felt yet.** Use the primitives, note what hurts, build for that.
- **The harness improves through feedback.** Agent fails → you update case → next agent succeeds. The loop compounds.
- **Lightweight beats elaborate.** Markdown files and habits beat complex tooling when the landscape is changing quickly.
