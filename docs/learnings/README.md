# Repo Learnings

Current tactical repo learnings live in each target repo's ignored `.case/learnings.md`.

The markdown files in this directory are legacy seeded learnings. They are versioned with Case and embedded into the portable binary as read-only fallback context when a target repo does not yet have `.case/learnings.md` and the user config directory does not have a legacy `learnings/<repo>.md` file.

## How it works

1. After every `/case` pipeline run, the retrospective agent analyzes what happened
2. If it discovers tactical knowledge specific to a repo, it appends to `<target-repo>/.case/learnings.md`
3. The implementer agent reads `.case/learnings.md` during setup, before writing code
4. If the same issue appears 3+ times in learnings, the retrospective escalates it to a convention or golden principle

## Format

Each entry is a dated bullet point with context:

```markdown
- **2026-03-08** — `src/middleware.ts`: Mock `next/headers` as a module, not individual exports. Individual mocks cause type errors in strict mode. (from task authkit-nextjs-1-issue-53)
```

## Rules

- Agents append entries — never edit or remove existing ones
- Entries must reference the source task
- Keep entries to 1-2 lines — tactical, not narrative
- If an entry is later proven wrong, append a correction entry rather than deleting
