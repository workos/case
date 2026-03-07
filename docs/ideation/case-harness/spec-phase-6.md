# Implementation Spec: Case Harness - Phase 6: Plugin Infrastructure

**Contract**: ./contract.md
**Estimated Effort**: M
**Blocked by**: Phases 1, 3, 4 (plugin needs manifest, docs, and playbooks to reference)

## Technical Approach

Package case as a Claude Code plugin that provides a `/case` skill. When installed, any agent in any repo can invoke `/case` to get harness context — landscape, conventions, playbooks, task dispatch instructions — without needing to be in the case/ directory.

The plugin follows the same structure as the existing `skills` plugin (../skills). The `/case` skill acts as a router: based on the user's task description, it loads the relevant subset of harness context (not everything at once — progressive disclosure).

The plugin depends on the `skills` plugin for WorkOS domain knowledge. Case provides orchestration context; skills provides product knowledge.

## Feedback Strategy

**Inner-loop command**: `cat .claude-plugin/plugin.json | node -e "process.stdin.resume(); process.stdin.on('data',d=>{JSON.parse(d);console.log('valid')})"`

**Playground**: Install the plugin locally in Claude Code and test that `/case` loads correctly and routes to the right context.

**Why this approach**: Plugin infrastructure is JSON config + markdown skills. Validation is: does it parse, and does Claude Code recognize it?

## File Changes

### New Files

| File Path | Purpose |
| --- | --- |
| `.claude-plugin/plugin.json` | Plugin manifest — declares the case plugin |
| `skills/case/SKILL.md` | The /case skill — router that loads harness context based on task |

## Implementation Details

### Plugin Manifest (`.claude-plugin/plugin.json`)

**Pattern to follow**: `../skills/.claude-plugin/plugin.json`

**Overview**: Declares case as a Claude Code plugin with its skills directory.

**Implementation steps**:
1. Read ../skills/.claude-plugin/plugin.json to understand the format
2. Create minimal plugin.json for case
3. Declare skills directory path

```json
{
  "name": "case",
  "description": "WorkOS OSS harness — cross-repo orchestration, conventions, and task dispatch",
  "skills": {
    "directory": "./skills"
  }
}
```

**Key decisions**:
- Keep the manifest minimal — the skill does the heavy lifting
- No marketplace.json needed for v1 (internal use only)

### /case Skill (`skills/case/SKILL.md`)

**Pattern to follow**: `../skills/plugins/workos/skills/workos/SKILL.md` (the router skill)

**Overview**: The main entry point skill. When invoked, it reads the task context and loads the relevant harness docs. It functions as a router — not a dump of all harness content.

**Key decisions**:
- Skill is a markdown file that Claude Code reads and follows
- Uses progressive disclosure: always loads the landscape (projects.json summary) and conventions overview, then drills into specific architecture/playbook docs based on the task
- References docs by path — Claude Code can then read those files
- Includes task dispatch instructions (how to use tasks/active/)

**Skill structure**:
```markdown
# Case — WorkOS OSS Harness

You are operating within the Case harness for WorkOS open source projects.

## Always Load

Read these first:
- `AGENTS.md` — project landscape and navigation
- `docs/golden-principles.md` — invariants to follow

## Task Routing

Based on the user's request, load the relevant context:

| If the task involves... | Read... |
| --- | --- |
| The CLI | `docs/architecture/cli.md` + `docs/playbooks/add-cli-command.md` |
| AuthKit framework integration | `docs/architecture/authkit-framework.md` + `docs/playbooks/add-authkit-framework.md` |
| Session management | `docs/architecture/authkit-session.md` |
| Skills plugin | `docs/architecture/skills-plugin.md` |
| Bug fix | `docs/playbooks/fix-bug.md` |
| Cross-repo change | `docs/playbooks/cross-repo-update.md` |
| Conventions/style | `docs/conventions/` (read the relevant file) |

## Task Dispatch

If the user wants to create a task for async execution:
1. Choose the right template from `tasks/templates/`
2. Fill in the placeholders
3. Save to `tasks/active/{repo}-{n}-{slug}.md`

## Working in a Target Repo

Before making changes in any target repo:
1. Read that repo's AGENTS.md
2. Run `scripts/bootstrap.sh {repo-name}` to verify readiness
3. Follow the repo's PR checklist before opening a PR
4. Run `scripts/check.sh --repo {repo-name}` before finalizing

## Improving the Harness

When an agent struggles or produces poor output, the fix goes into case/, not the code:
- Missing pattern? → Add to docs/architecture/
- Unclear convention? → Update docs/conventions/
- Recurring task? → Add a playbook + template
- Agent violation? → Add to docs/golden-principles.md and scripts/check.sh
```

**Implementation steps**:
1. Read ../skills router skill for format reference
2. Write SKILL.md with routing table covering all Phase 3 docs and Phase 4 playbooks
3. Include task dispatch instructions referencing Phase 4 templates
4. Include "improving the harness" section (the meta-loop)
5. Test by installing plugin and invoking /case with different task descriptions

**Feedback loop**:
- **Playground**: Install plugin in Claude Code, invoke /case with various prompts
- **Experiment**: Test with "add a CLI command", "fix a bug in authkit-nextjs", "update README across repos" — verify each routes to the right docs
- **Check command**: `grep -c "docs/" skills/case/SKILL.md` (verify doc references exist)

## Testing Requirements

- [ ] plugin.json is valid JSON
- [ ] Plugin can be discovered by Claude Code (install locally and verify)
- [ ] `/case` skill loads and displays routing table
- [ ] All doc paths referenced in SKILL.md exist as actual files
- [ ] Invoking `/case` with "add a CLI command" leads agent to correct architecture doc + playbook
- [ ] Invoking `/case` with "fix a bug" leads agent to fix-bug playbook

## Validation Commands

```bash
# Validate plugin.json
node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')); console.log('valid')"

# Verify skill file exists
[ -f skills/case/SKILL.md ] && echo "OK: skill exists" || echo "MISSING: skill"

# Verify all doc references in SKILL.md point to real files
grep -oE 'docs/[^ )`]+\.md' skills/case/SKILL.md | sort -u | while read ref; do
  [ -f "$ref" ] && echo "OK: $ref" || echo "BROKEN REF: $ref"
done

# Verify all template references point to real files
grep -oE 'tasks/[^ )`]+' skills/case/SKILL.md | sort -u | while read ref; do
  [ -e "$ref" ] && echo "OK: $ref" || echo "BROKEN REF: $ref"
done
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
