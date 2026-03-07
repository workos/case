# Implementation Spec: Case Harness - Phase 1: Spine Foundation

**Contract**: ./contract.md
**Estimated Effort**: M

## Technical Approach

Phase 1 creates the structural skeleton of the case harness. This is the foundation that all other phases build on: the workspace AGENTS.md that routes agents, the project manifest that describes the repo landscape, the CLAUDE.md that teaches agents how to improve the harness itself, and the directory structure for docs, tasks, and scripts.

The key design constraint is that AGENTS.md must be intentionally short (~100 lines) — a map, not a manual. It points to deeper docs that don't exist yet (those come in Phase 3). The manifest schema must accommodate 25+ repos even though v1 only populates 5.

The task system directory structure is created here, along with a documented task file format specification. This enables task-file dispatch immediately after Phase 1 — even before playbooks and templates exist in later phases.

## Feedback Strategy

**Inner-loop command**: `node -e "JSON.parse(require('fs').readFileSync('projects.json','utf8'))" && echo "manifest valid"`

**Playground**: CLI validation — check that projects.json parses, AGENTS.md is under 100 lines, all referenced paths exist.

**Why this approach**: All artifacts are static files (markdown + JSON). Validation is structural: does the JSON parse, are the paths real, is the AGENTS.md concise.

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `AGENTS.md` | Workspace-level routing map for agents (~100 lines) |
| `CLAUDE.md` | Instructions for agents working on case/ itself |
| `projects.json` | Manifest of all target repos with metadata |
| `projects.schema.json` | JSON Schema for the manifest (validates structure) |
| `tasks/README.md` | Task file format specification and naming conventions |
| `tasks/active/.gitkeep` | Empty dir for active task files |
| `tasks/done/.gitkeep` | Empty dir for completed task files |
| `tasks/templates/.gitkeep` | Empty dir for task templates (populated in Phase 4) |
| `docs/.gitkeep` | Empty dir for knowledge base (populated in Phase 3) |
| `scripts/.gitkeep` | Empty dir for enforcement scripts (populated in Phase 5) |

## Implementation Details

### AGENTS.md (Workspace Routing Map)

**Overview**: The single entry point for any agent landing in case/. Must be under 100 lines. Functions as a table of contents pointing to deeper sources of truth.

**Key decisions**:
- Map format, not prose — agents scan quickly
- References docs/ paths even before those files exist (Phase 3 creates them)
- Includes the project landscape inline (which repos, what they do) since this is the most frequently needed context
- Points to task system for dispatch workflow

**Implementation steps**:
1. Write header identifying case as a harness for WorkOS OSS repos
2. Add project landscape table (repo name, path, purpose, language/pm)
3. Add navigation section pointing to docs/architecture/, docs/conventions/, docs/playbooks/, docs/golden-principles.md
4. Add task dispatch section explaining the tasks/active/ workflow
5. Add "improving case" section pointing to CLAUDE.md
6. Verify line count is under 100

**Content structure**:
```markdown
# Case — WorkOS OSS Harness

{1-2 line description}

## Projects

| Repo | Path | Purpose | Stack |
| --- | --- | --- | --- |
| cli | ../cli/main | WorkOS CLI | TS/pnpm |
| ... | ... | ... | ... |

## Navigation

- Architecture: docs/architecture/
- Conventions: docs/conventions/
- Golden Principles: docs/golden-principles.md
- Playbooks: docs/playbooks/

## Task Dispatch

{Brief explanation of tasks/active/ workflow}
See: tasks/README.md

## Improving This Harness

See: CLAUDE.md
```

### CLAUDE.md (Meta-Instructions)

**Overview**: Instructions for agents working on case/ itself. This is where "never write code, only improve the harness" is encoded.

**Key decisions**:
- Distinct from AGENTS.md — CLAUDE.md is about improving case, AGENTS.md is about using case
- Includes the philosophy: when an agent struggles, fix the harness
- Documents the relationship to the skills plugin

**Implementation steps**:
1. Write project overview (case is a harness, spine/meta-repo pattern)
2. Document the "never write code" philosophy
3. List what belongs in case vs what belongs in individual repos
4. Document relationship to skills plugin (case = orchestration, skills = domain knowledge)
5. Add commands section (validation scripts from Phase 5, placeholder for now)

### projects.json (Manifest)

**Overview**: Machine-readable manifest of all target repos. Schema designed for 25+ repos but v1 populates 5.

**Key decisions**:
- JSON over TOML — parseable by agents and scripts without extra dependencies
- Separate schema file for validation
- Each repo entry includes: name, path (relative), remote, description, language, packageManager, and commands object (setup, test, lint, typecheck, build)
- Commands are copy-paste ready — agents execute them directly

**Implementation steps**:
1. Define JSON Schema in projects.schema.json
2. Populate projects.json with the 5 v1 repos
3. Pull actual commands from each repo's existing CLAUDE.md / package.json
4. Validate that all relative paths resolve correctly

```json
{
  "$schema": "./projects.schema.json",
  "repos": [
    {
      "name": "cli",
      "path": "../cli/main",
      "remote": "git@github.com:workos/workos-cli.git",
      "description": "WorkOS CLI for installing AuthKit integrations and managing resources",
      "language": "typescript",
      "packageManager": "pnpm",
      "commands": {
        "setup": "pnpm install",
        "build": "pnpm build",
        "test": "pnpm test",
        "lint": "pnpm lint",
        "typecheck": "pnpm typecheck"
      }
    }
  ]
}
```

### Task File Format (tasks/README.md)

**Overview**: Specification for how task files are structured. Agents and humans both need to know the format.

**Key decisions**:
- Naming convention: `{repo}-{n}-{slug}.md` for single-repo, `x-{n}-{slug}.md` for cross-repo
- Standard sections: Objective, Target Repos, Acceptance Criteria, Playbook Reference, Checklist
- The checklist is the agent's progress tracker — items get checked off as work progresses
- Task numbers are sequential per-prefix (cli-1, cli-2, authkit-1, x-1, etc.)

**Implementation steps**:
1. Document naming convention with examples
2. Define required sections and their purpose
3. Include a minimal example task file
4. Document lifecycle: active/ → done/ (moved after PR merge)

## Testing Requirements

No automated tests for Phase 1. Validation is manual/structural:

- [ ] `projects.json` parses as valid JSON
- [ ] `projects.json` validates against `projects.schema.json`
- [ ] All `path` values in projects.json resolve to existing directories
- [ ] All `commands` values in projects.json are accurate (spot-check by running them)
- [ ] `AGENTS.md` is under 100 lines
- [ ] `AGENTS.md` references all 5 v1 repos
- [ ] Directory structure exists: docs/, tasks/active/, tasks/done/, tasks/templates/, scripts/

## Validation Commands

```bash
# Validate manifest JSON
node -e "JSON.parse(require('fs').readFileSync('projects.json','utf8')); console.log('valid')"

# Check AGENTS.md line count
wc -l AGENTS.md  # should be < 100

# Verify all repo paths exist
node -e "
const m = JSON.parse(require('fs').readFileSync('projects.json','utf8'));
const fs = require('fs');
const path = require('path');
m.repos.forEach(r => {
  const p = path.resolve(r.path);
  if (!fs.existsSync(p)) console.error('MISSING:', r.name, p);
  else console.log('OK:', r.name, p);
});
"

# Verify directory structure
ls -d docs/ tasks/active/ tasks/done/ tasks/templates/ scripts/
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
