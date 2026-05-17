# workos-node Learnings

Tactical knowledge for the WorkOS Node SDK. See [README.md](README.md) for format and rules.

<!-- Retrospective agent appends entries below. Do not edit existing entries. -->

- **2026-03-18** — `repo type`: `workos-node` is a pure SDK library with no web UI or example app. Playwright manual testing is not applicable — the test suite (Jest/npm test) is the authoritative verification mechanism. Do not attempt Playwright evidence when working in this repo. The `.case-manual-tested` marker cannot be satisfied by `mark-manual-tested.sh` without real screenshot evidence. See pending amendment `2026-03-16-pre-pr-skip-manual-test-for-library-repos.md` for the fix. (from task workos-node-1-issue-1523)
- **2026-05-17** — Correction: Case evidence now lives under `.case/<task-slug>/`; use `ca mark-manual-tested --library` when library scenario verification applies instead of the old `.case-manual-tested` marker/script wording. (from task portable-binary-assets)
