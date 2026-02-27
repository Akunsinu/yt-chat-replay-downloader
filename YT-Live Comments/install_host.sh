#!/bin/bash
# Install native messaging host for YouTube Video Archiver
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.ytarchiver.downloader"
HOST_SCRIPT="$SCRIPT_DIR/native_host/yt_dlp_host.py"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

echo "=== YouTube Video Archiver - Native Host Setup ==="
echo ""

# Check yt-dlp
if ! command -v yt-dlp &> /dev/null; then
    echo "ERROR: yt-dlp not found. Install it:"
    echo "  brew install yt-dlp"
    exit 1
fi
echo "yt-dlp $(yt-dlp --version)"

# Check python3
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

# Make host script executable
chmod +x "$HOST_SCRIPT"

# Create manifest directory
mkdir -p "$MANIFEST_DIR"

# Write native messaging host manifest
cat > "$MANIFEST_DIR/$HOST_NAME.json" << EOF
{
  "name": "$HOST_NAME",
  "description": "yt-dlp downloader for YouTube Video Archiver",
  "path": "$HOST_SCRIPT",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo ""
echo "Native messaging host installed!"
echo "  Manifest: $MANIFEST_DIR/$HOST_NAME.json"
echo "  Script:   $HOST_SCRIPT"
echo ""
echo "Reload the extension and try downloading a video."
