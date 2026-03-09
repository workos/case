# Case Video Verification Contract

**Created**: 2026-03-08
**Confidence Score**: 95/100
**Status**: Approved

## Problem Statement

PR descriptions currently include screenshots (static images) of the verification flow. Screenshots show the end state but not the interaction — clicks, transitions, loading states, the actual flow. Video captures the full experience and adds significantly more credibility to the verification evidence.

`playwright-cli` already supports `video-start` / `video-stop` natively (WebM output). The upload script already handles video files (`<video>` tag for GitHub markdown). The infrastructure exists — it's just not wired into the verifier agent.

## Goals

1. Verifier agent records a video of the entire test flow using `playwright-cli video-start/video-stop`
2. Video is uploaded via the existing upload script and embedded in the PR description
3. Closer agent includes the video alongside screenshots in the PR body

## Success Criteria

- [ ] Verifier starts video recording before the test flow
- [ ] Verifier stops recording and saves to a `.webm` file after the flow
- [ ] Video is uploaded via `upload-screenshot.sh` and returns a `<video>` tag
- [ ] Closer embeds the video in the PR description
- [ ] SKILL.md verification tools section documents video recording

## Scope Boundaries

### In Scope

- Update `agents/verifier.md` with video-start/video-stop workflow
- Update `agents/closer.md` to embed video in PR description
- Update SKILL.md verification tools section to document video

### Out of Scope

- WebM to MP4 conversion (GitHub renders `<video>` tags with WebM)
- Modifying the upload script (already handles video)
- Modifying playwright-cli itself

## Execution Plan

Single spec, no phasing.

```
/ideation:execute-spec docs/ideation/case-video-verification/spec.md
```
