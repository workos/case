#!/usr/bin/env bash
# Upload a screenshot/video to the case-assets repo as a release asset
# Returns a markdown image/video tag ready to paste into a PR body
#
# Usage:
#   bash scripts/upload-screenshot.sh /path/to/screenshot.png
#   bash scripts/upload-screenshot.sh /path/to/video.mp4
#
# Requires:
#   - gh CLI authenticated
#   - workos/case-assets repo exists with a release named "assets"

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
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ASSET_NAME="${TIMESTAMP}-${FILENAME}"

# Ensure the release exists (create if not)
if ! gh release view "$RELEASE_TAG" --repo "$ASSETS_REPO" > /dev/null 2>&1; then
  echo "Creating release '$RELEASE_TAG' in $ASSETS_REPO..." >&2
  gh release create "$RELEASE_TAG" --repo "$ASSETS_REPO" --title "PR Assets" --notes "Screenshots and videos for PR descriptions. Uploaded by case harness." 2>&1 >&2
fi

# Upload the asset
echo "Uploading $FILENAME..." >&2
gh release upload "$RELEASE_TAG" "$FILE_PATH" --repo "$ASSETS_REPO" --clobber 2>&1 >&2

# Get the download URL
DOWNLOAD_URL=$(gh release view "$RELEASE_TAG" --repo "$ASSETS_REPO" --json assets --jq ".assets[] | select(.name == \"$FILENAME\") | .url")

if [[ -z "$DOWNLOAD_URL" ]]; then
  echo "Failed to get download URL for $FILENAME" >&2
  exit 1
fi

# Output markdown based on file type
case "$EXTENSION" in
  png|jpg|jpeg|gif|webp)
    echo "![${FILENAME}](${DOWNLOAD_URL})"
    ;;
  mp4|mov|webm)
    echo "<video src=\"${DOWNLOAD_URL}\" controls></video>"
    ;;
  *)
    echo "[${FILENAME}](${DOWNLOAD_URL})"
    ;;
esac
