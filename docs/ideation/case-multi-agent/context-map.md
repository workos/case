# Context Map: case-multi-agent

**Phase**: 1
**Scout Confidence**: 92/100
**Verdict**: GO

## Dimensions

| Dimension | Score | Notes |
|---|---|---|
| Scope clarity | 19/20 | All 10 files identified. Only `.case-active` format slightly ambiguous (Phase 3 responsibility). |
| Pattern familiarity | 20/20 | `projects.schema.json` is the pattern for JSON Schema. Shell scripts follow existing conventions. |
| Dependency awareness | 18/20 | post-pr-cleanup → task-status.sh, marker scripts → task-status.sh, pre-pr-check reads `.case-active` (unchanged). |
| Edge case coverage | 17/20 | Backward compat (old-format fallback), transition validation, `--from-marker` guard. Missing: exhaustive invalid transition tests. |
| Test strategy | 18/20 | Validation commands provided. Feedback loop via task-status.sh. No formal test framework but shell scripts are testable manually. |

## Key Patterns

- `projects.schema.json` — JSON Schema conventions: `$schema`, `$defs` for reusable types, `required` array, `enum` for fixed values, `type: ["string", "null"]` for nullable fields.

## Dependencies

- `hooks/post-pr-cleanup.sh` — consumed by → `hooks/hooks.json` (PostToolUse matcher on Bash)
- `scripts/mark-tested.sh` — consumed by → SKILL.md pre-PR checklist, implementer agent
- `scripts/mark-manual-tested.sh` — consumed by → SKILL.md pre-PR checklist, verifier agent
- `scripts/task-status.sh` (new) — will be consumed by → post-pr-cleanup.sh, mark-tested.sh, mark-manual-tested.sh, orchestrator, all agents
- `tasks/README.md` — consumed by → SKILL.md Task Dispatch section

## Conventions

- **Naming**: Shell scripts use kebab-case (`mark-tested.sh`, `task-status.sh`). JSON fields use camelCase.
- **Error handling**: Scripts use `set -uo pipefail` (not `-e` due to grep exit codes). Exit 2 for enforcement failures.
- **Shell style**: Python3 inline for JSON manipulation. `cat` for stdin reading. Clear error messages to stderr.
- **Templates**: Markdown with `## Section` headers and `- [ ]` checkboxes. Consistent structure across all 4 templates.

## Risks

- `.case-active` format: Phase 1 reads it but Phase 3 writes it. Format must be agreed (plain text task ID, one line, no trailing newline). Phase 1 should handle both empty and populated `.case-active` gracefully.
- Backward compatibility: Old-format tasks (no `.task.json`) must still work through the file-move fallback path.
- Status transition complexity: 8 forward + 3 recovery transitions. Implementation must reject all other paths.
