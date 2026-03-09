# Implementation Spec: Case Video Verification

**Contract**: ./contract.md
**Estimated Effort**: S

## Technical Approach

Wire `playwright-cli video-start` / `video-stop` into the verifier agent's workflow so every manual test flow is recorded as a `.webm` video. Upload via the existing `upload-screenshot.sh` (already handles video). Update the closer to embed the `<video>` tag in the PR description alongside screenshots.

## File Changes

### Modified Files

| File Path | Changes |
|-----------|---------|
| `agents/verifier.md` | Add video-start before test flow, video-stop after, upload .webm, include video tag in progress log |
| `agents/closer.md` | Reference video from verifier's progress log in PR description |
| `skills/case/SKILL.md` | Update Verification Tools section to document video recording with playwright-cli |

## Implementation Details

### Verifier Video Recording

**Pattern to follow**: Current `agents/verifier.md` section "### 4. Capture Evidence"

**Overview**: Wrap the test flow in video-start/video-stop. The video captures the entire interaction — navigation, clicks, form fills, transitions — not just the end state.

**Implementation steps**:

1. Read current `agents/verifier.md`
2. In section "### 3. Test the Specific Fix", add `video-start` before step 8 (navigate):
   ```bash
   playwright-cli video-start
   ```
3. In section "### 4. Capture Evidence", add `video-stop` as the first step (before screenshots):
   ```bash
   playwright-cli video-stop /tmp/verification.webm
   ```
4. Add video upload after screenshots:
   ```bash
   VIDEO=$(/Users/nicknisi/Developer/case/scripts/upload-screenshot.sh /tmp/verification.webm)
   echo "$VIDEO"
   ```
   The upload script returns `<video src="url" controls></video>` for video files.
5. Update the progress log template to include video:
   ```markdown
   - Video: <video tag from upload>
   - Screenshots: <screenshot markdown>
   ```
6. Update the AGENT_RESULT artifacts to include video URL in `screenshotUrls` (reuse the field — it's for all visual evidence, not just screenshots)

### Closer Video Embedding

**Pattern to follow**: Current `agents/closer.md` section "### 2. Draft PR"

**Overview**: The closer reads video tags from the verifier's progress log and includes them in the PR body under a "## Verification" section.

**Implementation steps**:

1. Read current `agents/closer.md`
2. Update the PR body template to include video:
   ```markdown
   ## Verification

   ### Video
   <video tag from verifier>

   ### Screenshots
   <screenshot tags from verifier>
   ```
3. In "### 1. Gather context", add: read video tags from the verifier's progress log entry (look for `<video` tags or `.webm` references)

### SKILL.md Video Documentation

**Pattern to follow**: Current SKILL.md "### Playwright (primary for front-end)" section

**Overview**: Add video recording to the quick reference and document the workflow.

**Implementation steps**:

1. Read current SKILL.md Verification Tools section
2. Add to the Playwright quick reference:
   ```bash
   playwright-cli video-start                    # start recording
   playwright-cli video-stop /tmp/demo.webm      # stop and save
   ```
3. Add a note in PR verification artifacts about video:
   ```
   For front-end changes, record a video of the verification flow:
   1. playwright-cli video-start
   2. ... run the test flow ...
   3. playwright-cli video-stop /tmp/verification.webm
   4. Upload: VIDEO=$(scripts/upload-screenshot.sh /tmp/verification.webm)
   ```

## Validation Commands

```bash
# Verify verifier mentions video-start
grep "video-start" agents/verifier.md && echo "OK" || echo "FAIL"

# Verify verifier mentions video-stop
grep "video-stop" agents/verifier.md && echo "OK" || echo "FAIL"

# Verify closer mentions video
grep -i "video" agents/closer.md && echo "OK" || echo "FAIL"

# Verify SKILL.md mentions video
grep "video-start" skills/case/SKILL.md && echo "OK" || echo "FAIL"
```

---

_This spec is ready for implementation. Follow the patterns and validate at each step._
