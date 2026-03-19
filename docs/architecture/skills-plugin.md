# Architecture: Skills Plugin

> `../skills/` | TypeScript (tsx, no build) | pnpm

## Overview

The skills repo provides WorkOS integration skills. It ships curated knowledge (AuthKit installation guides, API references, migration guides) to coding agents so they produce correct WorkOS implementations.

## Plugin Structure

```
skills/
├── plugins/workos/
│   ├── .claude-plugin/
│   │   └── plugin.json          # Plugin manifest (name, description, version)
│   └── skills/
│       ├── workos/              # Router skill
│       │   ├── SKILL.md         # Routes user intent to correct skill/topic
│       │   └── references/      # Topic files (*.md)
│       ├── workos-authkit-nextjs/
│       │   └── SKILL.md         # Hand-crafted AuthKit Next.js skill
│       ├── workos-authkit-react/
│       │   └── SKILL.md
│       ├── workos-authkit-react-router/
│       │   └── SKILL.md
│       ├── workos-authkit-tanstack-start/
│       │   └── SKILL.md
│       ├── workos-authkit-vanilla-js/
│       │   └── SKILL.md
│       ├── workos-authkit-base/
│       │   └── SKILL.md         # AuthKit architecture reference
│       └── workos-widgets/
│           ├── SKILL.md
│           └── references/      # Widget-specific reference files
├── scripts/                     # Eval framework (not shipped with plugin)
├── vitest.config.ts
└── package.json
```

### Plugin Manifest

`plugins/workos/.claude-plugin/plugin.json`:

```json
{
  "name": "workos",
  "description": "WorkOS integration skills for AuthKit, SSO, Directory Sync, ...",
  "version": "1.0.0",
  "author": { "name": "WorkOS", "email": "support@workos.com" }
}
```

Only the `plugins/workos/` directory gets cached/installed by agents.

## Skill Types

### 1. Hand-Crafted AuthKit Skills

Located in `plugins/workos/skills/workos-authkit-{framework}/SKILL.md`.

These are step-by-step installation guides for specific frameworks. Each follows a rigid structure:

1. **Fetch SDK Documentation (BLOCKING)** -- WebFetch the README first
2. **Pre-Flight Validation** -- check project structure + env vars
3. **Install SDK** -- detect package manager, install
4. **Version Detection** -- framework version decision tree
5. **Framework-specific setup** -- middleware, callback route, provider
6. **Verification Checklist** -- concrete commands to validate
7. **Error Recovery** -- common failure modes + fixes

Key principle: **README is the source of truth**. Skills say "If this file conflicts with README, follow README."

### 2. Router Skill

`plugins/workos/skills/workos/SKILL.md`

The main entry point. Contains tables mapping user intent to the correct skill or topic file:

- **AuthKit tasks** --> load skill by name (e.g., `workos-authkit-nextjs`)
- **Feature tasks** --> read `references/{topic}.md` (e.g., `workos-sso.md`)
- **API references** --> read `references/workos-api-{domain}.md`
- **Migrations** --> read `references/workos-migrate-{provider}.md`

### 3. Topic Files

`plugins/workos/skills/workos/references/*.md`

Lean files containing:

- **Doc URLs** -- links to official WorkOS documentation (source of truth)
- **Gotchas** -- non-obvious traps that LLMs commonly get wrong
- **Endpoint tables** (optional) -- API reference for the topic

Topic files are human-maintained. No generation pipeline. The pattern:

> "If this file conflicts with fetched docs, follow the docs."

Current topic files cover: SSO, Directory Sync, RBAC, Vault, Events, Audit Logs, Admin Portal, MFA, Email, Custom Domains, Integrations, plus migration guides for Auth0, Clerk, Firebase, Cognito, Stytch, Supabase, Descope, Better Auth.

## "Fetch Docs First" Pattern

Every skill and topic file starts with a blocking instruction to fetch official documentation before proceeding. This ensures the agent has current information and the skill only provides supplementary guidance (gotchas, decision trees, verification steps).

## Eval Framework

Located in `scripts/` (not shipped with the plugin).

Purpose: Measure whether skills improve agent-generated WorkOS implementations.

### How It Works

1. Defines test cases (product + language + scenario)
2. Runs each case **with** and **without** the skill
3. Scores both outputs with a composite scorer
4. Reports the delta (positive = skill helps)

### Key Commands

```bash
pnpm eval -- --dry-run                        # verify cases load
pnpm eval -- --no-cache --case=sso-node-basic # run single case
pnpm eval -- --no-cache --fail-on-regression  # CI gate
pnpm eval -- --no-cache --samples=2           # variance measurement
```

### Eval Tooling

```bash
pnpm eval:diff -- --case=X       # side-by-side transcript diff
pnpm eval:label -- --case=X ...  # add human judgment label
pnpm eval:calibrate              # scorer vs human agreement
```

### Key Files

| File                        | Purpose                     |
| --------------------------- | --------------------------- |
| `scripts/eval.ts`           | Main eval runner            |
| `scripts/eval/scorer.ts`    | Composite scoring logic     |
| `scripts/eval/reporter.ts`  | Results reporting           |
| `scripts/eval/triage.ts`    | Risk triage report          |
| `scripts/eval/calibrate.ts` | Scorer-vs-human calibration |
| `scripts/eval/diff.ts`      | Transcript diff viewer      |
| `scripts/eval-label.ts`     | Human label tool            |

### Interpreting Results

- **Delta >= +20%** (GREEN): strong skill value
- **Delta >= +10%** (YELLOW): moderate
- **Delta < +10%** (RED): low value
- **Negative delta**: skill hurts -- investigate wrong information

Hard gates (`--fail-on-regression`): no product with negative avg delta, hallucination reduction >= 50%.

## Adding Content

### New Topic File

1. Create `plugins/workos/skills/workos/references/workos-{topic}.md`
2. Start with doc URL + "fetch docs first" instruction
3. Add gotchas as you discover LLM failure modes
4. Add to router table in `plugins/workos/skills/workos/SKILL.md`

### New Hand-Crafted Skill

1. Create `plugins/workos/skills/workos-{name}/SKILL.md`
2. Follow the 7-step structure from existing AuthKit skills
3. Start with WebFetch blocking step
4. Add to router table in the router skill

### New Gotcha

Edit the relevant topic file or SKILL.md directly. Add a bullet under the Gotchas section describing what the LLM gets wrong and the correct behavior.
