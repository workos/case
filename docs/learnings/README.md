# Repo Learnings (External)

Per-repo tactical knowledge is stored in a separate GitHub repo, configured via the `CASE_LEARNINGS_REPO` environment variable. This keeps codebase-specific knowledge out of the open-source harness repo.

## Setup

1. Create a GitHub repo for learnings:
   ```bash
   gh repo create case-learnings --public --description "Per-repo tactical knowledge for case harness"
   ```

2. Set the env var:
   ```bash
   export CASE_LEARNINGS_REPO='youruser/case-learnings'
   ```
   Add this to your shell profile or Claude Code settings for persistence.

## How it works

1. After every pipeline run, the retrospective agent calls `scripts/write-learning.sh` to append tactical knowledge
2. Before coding, the implementer agent calls `scripts/read-learning.sh` to load tactical knowledge
3. If 3+ similar entries accumulate, the retrospective escalates to a convention or golden principle (in the case repo)
4. Each fork/user has their own learnings repo — knowledge doesn't leak across forks

## Format

Each entry is a dated bullet point:

```markdown
- **2026-03-08** — `src/middleware.ts`: Mock `next/headers` as a module, not individual exports. (from task authkit-nextjs-1-issue-53)
```

## Scripts

- `scripts/read-learning.sh <repo>` — read a repo's learnings (stdout)
- `scripts/write-learning.sh <repo> <entry>` — append an entry and commit to the external repo

## Rules

- Agents append entries — never edit or remove existing ones
- Entries must reference the source task
- Keep entries to 1-2 lines — tactical, not narrative
- If an entry is later proven wrong, append a correction entry rather than deleting
