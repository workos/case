#!/usr/bin/env bash
# Upload a screenshot/video to the case-assets repo as a release asset.
# Returns markdown ready to paste into a PR body.
#
# For videos: converts to mp4 if needed and returns a download link.
# Screenshots are the primary inline evidence; videos are supplementary.
#
# Usage:
#   bash scripts/upload-screenshot.sh /path/to/screenshot.png
#   bash scripts/upload-screenshot.sh /path/to/video.mp4
#   bash scripts/upload-screenshot.sh /path/to/video.webm
#
# Requires:
#   - gh CLI authenticated
#   - case-assets repo exists with a release named "assets"
#   - ffmpeg (for webm → mp4 conversion, optional)

set -euo pipefail

ASSETS_REPO="nicknisi/case-assets"
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
    # Video workflow: upload mp4 as download link.
    # No GIF conversion — screenshots are the primary inline evidence.
    MP4_PATH="$FILE_PATH"

    # Convert to mp4 first if webm
    if [[ "$EXTENSION" == "webm" ]] && command -v ffmpeg &>/dev/null; then
      STEM="${FILENAME%.*}"
      echo "Converting webm to mp4..." >&2
      MP4_PATH="/tmp/${STEM}.mp4"
      ffmpeg -y -i "$FILE_PATH" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$MP4_PATH" 2>/dev/null
    fi

    echo "Uploading video..." >&2
    MP4_URL=$(upload_asset "$MP4_PATH")

    if [[ -z "$MP4_URL" ]]; then
      echo "Failed to get download URL" >&2
      exit 1
    fi

    echo "[▶ Download verification video](${MP4_URL})"
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
