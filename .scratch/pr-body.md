## Problem

On a fresh checkout of `main`, anything that imports the embedded asset manifest fails before running:

```
error: Cannot find module '../../docs/agent-versions/implementer-2026-05-17.md' from '…/src/generated/package-assets.ts'
```

## Cause

`src/dev/generate-package-assets.ts` walked `agents/`, `docs/` and `ast-rules/` on disk, so it embedded whatever was in the developer's checkout, including gitignored local files. The committed manifest (last regenerated in #16) imported 27 files git doesn't track:

- `docs/agent-versions/implementer-2026-05-17.md`
- 14 files under `docs/ideation/`
- 12 dated `docs/proposed-amendments/*.md` files

Bun only reports the first missing import, so the error names just the `agent-versions` file.

## What changed

- The generator now lists assets with `git ls-files --cached --others --exclude-standard`. That covers tracked files plus new files git doesn't ignore, so a doc you just added gets embedded before `git add`. Gitignored files are left out. Force-tracked files under ignored folders (`docs/learnings/*.md`) are still embedded.
- If the root isn't a git checkout, or git isn't available, it falls back to the old disk walk and prints a warning to stderr.
- Regenerated `src/generated/package-assets.ts`. It drops the 27 untracked entries and renumbers the imports. Nothing is added. Nothing in `src/` reads those paths through the embedded assets.
- New tests in `src/__tests__/package-assets.spec.ts`:
  - every key in the committed manifest is a file git tracks
  - in a throwaway git repo, the generator leaves out an ignored file and keeps a tracked one

## Test output

```
$ bun test ./src/__tests__/package-assets.spec.ts
(pass) package assets > falls back to embedded assets when no package root exists on disk
(pass) package assets > prefers disk assets so local development and tests can override embedded content
(pass) package assets > reports existence across disk and embedded assets
(pass) package assets in a fresh checkout > embeds only files git tracks in this repository
(pass) package assets in a fresh checkout > generator leaves out gitignored files and keeps tracked ones
 5 pass
 0 fail
```

Against the old code, both new tests fail. The old manifest doesn't load, and the old generator embeds the ignored fixture file.

`bun test ./src/__tests__/` now loads with no local `docs/agent-versions/` file: 689 pass, 1 fail. The one failure, `synthesizeProjectEntry > keeps detected command when override value is empty`, is already on `main` and unrelated. da40a0a made an empty override delete the command, but the test wasn't updated. `bun test --cwd test/standalone`: 9 pass, 0 fail.
