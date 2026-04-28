#!/bin/bash
# Install native messaging host for YouTube Video Archiver.
#
# IMPORTANT: This script copies the Python host into
#   ~/Library/Application Support/com.ytarchiver.downloader/
# rather than registering the in-repo path. macOS Sonoma+ blocks Chrome's
# native-host child processes from reading files inside ~/Documents,
# ~/Desktop, and ~/Downloads (TCC), which silently breaks the host with
# "Operation not permitted" if the script lives in any of those folders.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.ytarchiver.downloader"
SRC_HOST="$SCRIPT_DIR/native_host/yt_dlp_host.py"

# TCC-safe install location. Outside Documents/Desktop/Downloads.
INSTALL_DIR="$HOME/Library/Application Support/$HOST_NAME"
INSTALLED_HOST="$INSTALL_DIR/yt_dlp_host.py"

MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"

echo "=== YouTube Video Archiver - Native Host Setup ==="
echo ""

# Sanity: source script must exist
if [ ! -f "$SRC_HOST" ]; then
    echo "ERROR: Cannot find host script at $SRC_HOST"
    exit 1
fi

# Check yt-dlp
if ! command -v yt-dlp &> /dev/null; then
    echo "ERROR: yt-dlp not found. Install it with:"
    echo "  brew install yt-dlp ffmpeg"
    exit 1
fi
echo "yt-dlp $(yt-dlp --version)"

# Check ffmpeg — warn but don't fail. yt-dlp downloads work without it but
# get capped at 720p (single-file format) because we can't merge YouTube's
# separate video and audio streams. Most users want HD, so flag this loudly.
if ! command -v ffmpeg &> /dev/null; then
    echo ""
    echo "WARNING: ffmpeg not found."
    echo "  Without ffmpeg, downloads are limited to 720p (single-file format)."
    echo "  YouTube's HD streams are split into separate video and audio that"
    echo "  need ffmpeg to merge. Install it with:"
    echo "    brew install ffmpeg"
    echo ""
else
    echo "ffmpeg $(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
fi

# Check python3 (Chrome will use /usr/bin/python3 — Apple-shipped one)
if ! command -v python3 &> /dev/null; then
    echo "ERROR: python3 not found."
    exit 1
fi
echo "$(python3 --version)"

# Get extension ID
echo ""
echo "Enter your extension ID from chrome://extensions (enable Developer mode):"
read -p "> " EXT_ID

if [ -z "$EXT_ID" ]; then
    echo "ERROR: Extension ID required."
    exit 1
fi

# 32 lowercase letters a-p, anything else is a typo
if ! echo "$EXT_ID" | grep -qE '^[a-p]{32}$'; then
    echo "WARNING: Extension ID '$EXT_ID' doesn't look right (expected 32 lowercase letters a-p)."
    read -p "Continue anyway? [y/N] " ANS
    case "$ANS" in
        y|Y) ;;
        *) echo "Aborted."; exit 1 ;;
    esac
fi

# Copy host into TCC-safe location
mkdir -p "$INSTALL_DIR"
cp "$SRC_HOST" "$INSTALLED_HOST"
chmod +x "$INSTALLED_HOST"

# Create manifest directory
mkdir -p "$MANIFEST_DIR"

# Write native messaging host manifest pointing at the installed copy
cat > "$MANIFEST_PATH" << EOF
{
  "name": "$HOST_NAME",
  "description": "yt-dlp downloader for YouTube Video Archiver",
  "path": "$INSTALLED_HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo ""
echo "Native messaging host installed!"
echo "  Host script: $INSTALLED_HOST"
echo "  Manifest:    $MANIFEST_PATH"
echo "  Logs:        $HOME/Library/Logs/$HOST_NAME/"
echo ""
echo "Reload the extension and click Re-check in the side panel."
