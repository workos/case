#!/usr/bin/env bash
# Upload a screenshot/video to the case-assets repo as a release asset.
# Returns markdown ready to paste into a PR body.
#
# For videos: also converts to animated GIF for inline rendering, since GitHub
# only renders inline video from user-attachments URLs (web UI uploads).
# Returns both a GIF image tag (renders inline) and an mp4 download link.
#
# Usage:
#   bash scripts/upload-screenshot.sh /path/to/screenshot.png
#   bash scripts/upload-screenshot.sh /path/to/video.mp4
#   bash scripts/upload-screenshot.sh /path/to/video.webm
#
# Requires:
#   - gh CLI authenticated
#   - case-assets repo exists with a release named "assets"
#   - ffmpeg (for video → GIF conversion)

set -euo pipefail

if [[ -z "${CASE_ASSETS_REPO:-}" ]]; then
  echo "ERROR: CASE_ASSETS_REPO is not set." >&2
  echo "" >&2
  echo "This script uploads screenshots/videos to a GitHub repo as release assets." >&2
  echo "Set CASE_ASSETS_REPO to your own GitHub repo (e.g., 'youruser/case-assets')." >&2
  echo "" >&2
  echo "Setup:" >&2
  echo "  1. Create a GitHub repo for assets (e.g., gh repo create case-assets --public)" >&2
  echo "  2. Export the env var: export CASE_ASSETS_REPO='youruser/case-assets'" >&2
  echo "  3. Or add it to your shell profile / Claude Code settings" >&2
  exit 1
fi

ASSETS_REPO="$CASE_ASSETS_REPO"
RELEASE_TAG="assets"

if [[ $# -lt 1 ]]; then
  echo "Usage: upload-screenshot.sh <file-path>" >&2
  exit 1
fi

FILE_PATH="$1"

if [[ ! -f "$FILE_PATH" ]]; then
  echo "File not found: $FILE_PATH" >&2
  exit 1
fi

FILENAME=$(basename "$FILE_PATH")
EXTENSION="${FILENAME##*.}"

# Ensure the release exists (create if not)
if ! gh release view "$RELEASE_TAG" --repo "$ASSETS_REPO" > /dev/null 2>&1; then
  echo "Creating release '$RELEASE_TAG' in $ASSETS_REPO..." >&2
  gh release create "$RELEASE_TAG" --repo "$ASSETS_REPO" --title "PR Assets" --notes "Screenshots and videos for PR descriptions. Uploaded by case harness." 2>&1 >&2
fi

upload_asset() {
  local file="$1"
  local name
  name=$(basename "$file")
  gh release upload "$RELEASE_TAG" "$file" --repo "$ASSETS_REPO" --clobber 2>&1 >&2
  gh release view "$RELEASE_TAG" --repo "$ASSETS_REPO" --json assets --jq ".assets[] | select(.name == \"$name\") | .url"
}

case "$EXTENSION" in
  png|jpg|jpeg|gif|webp)
    echo "Uploading $FILENAME..." >&2
    URL=$(upload_asset "$FILE_PATH")
    if [[ -z "$URL" ]]; then
      echo "Failed to get download URL for $FILENAME" >&2
      exit 1
    fi
    echo "![${FILENAME}](${URL})"
    ;;

  mp4|mov|webm)
    # Video workflow: convert to GIF (renders inline) + upload mp4 (download link)
    STEM="${FILENAME%.*}"
    GIF_PATH="/tmp/${STEM}.gif"
    MP4_PATH="$FILE_PATH"

    # Convert to mp4 first if webm
    if [[ "$EXTENSION" == "webm" ]]; then
      echo "Converting webm to mp4..." >&2
      MP4_PATH="/tmp/${STEM}.mp4"
      ffmpeg -y -i "$FILE_PATH" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$MP4_PATH" 2>/dev/null
    fi

    # Convert to GIF for inline rendering
    echo "Converting to animated GIF for inline rendering..." >&2
    if command -v ffmpeg &>/dev/null; then
      ffmpeg -y -i "$FILE_PATH" -vf "fps=10,scale=800:-1:flags=lanczos" -loop 0 "$GIF_PATH" 2>/dev/null
    else
      echo "WARNING: ffmpeg not found — cannot create GIF. Only mp4 download link will be available." >&2
      echo "Uploading $FILENAME..." >&2
      URL=$(upload_asset "$MP4_PATH")
      echo "[$FILENAME]($URL)"
      exit 0
    fi

    # Upload both
    echo "Uploading GIF (inline preview)..." >&2
    GIF_URL=$(upload_asset "$GIF_PATH")
    echo "Uploading mp4 (full quality download)..." >&2
    MP4_URL=$(upload_asset "$MP4_PATH")

    if [[ -z "$GIF_URL" || -z "$MP4_URL" ]]; then
      echo "Failed to get download URLs" >&2
      exit 1
    fi

    # Output both: GIF for inline, mp4 as download link
    # The GIF renders inline in GitHub markdown. The mp4 link is for full quality.
    echo "![${STEM}.gif](${GIF_URL})"
    echo ""
    echo "[Download full quality video](${MP4_URL})"
    ;;

  *)
    echo "Uploading $FILENAME..." >&2
    URL=$(upload_asset "$FILE_PATH")
    if [[ -z "$URL" ]]; then
      echo "Failed to get download URL for $FILENAME" >&2
      exit 1
    fi
    echo "[${FILENAME}](${URL})"
    ;;
esac
