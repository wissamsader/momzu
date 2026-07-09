#!/bin/bash
# Momzu installer — https://momzu.space
# Downloads the latest Momzu, installs it to /Applications, and opens it.
# Installing this way skips macOS's "damaged / unverified developer" dialog:
# files fetched with curl never get the browser quarantine flag.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Momzu is a Mac app — this installer only runs on macOS."
  exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "Momzu needs an Apple Silicon Mac (M1 or newer)."
  exit 1
fi

TMP="$(mktemp -d)"
cleanup() {
  [ -n "${MOUNT:-}" ] && hdiutil detach "$MOUNT" -quiet 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "▸ Downloading Momzu (about 220 MB)…"
curl -fL --progress-bar -o "$TMP/Momzu.dmg" \
  "https://github.com/wissamsader/momzu/releases/latest/download/Momzu.dmg"

echo "▸ Installing to /Applications…"
MOUNT="$(hdiutil attach "$TMP/Momzu.dmg" -nobrowse -readonly | awk -F'\t' '/\/Volumes\//{print $NF; exit}')"
rm -rf /Applications/Momzu.app
ditto "$MOUNT/Momzu.app" /Applications/Momzu.app
hdiutil detach "$MOUNT" -quiet
MOUNT=""
# Belt and braces: strip any quarantine flag so Gatekeeper stays quiet.
xattr -cr /Applications/Momzu.app 2>/dev/null || true

echo "▸ Opening Momzu…"
# Open by path — LaunchServices can be slow to learn the name of a
# just-installed app, which makes `open -a Momzu` fail on first install.
open /Applications/Momzu.app
echo "✓ Done — Momzu is installed in your Applications folder."
