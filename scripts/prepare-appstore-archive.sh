#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TARGET=${1:-"$ROOT_DIR/openTranslate"}

if [ ! -e "$TARGET" ]; then
  echo "Archive or project path not found: $TARGET" >&2
  exit 1
fi

xattr -dr com.apple.quarantine "$TARGET"

if xattr -lr "$TARGET" 2>/dev/null | grep -q 'com.apple.quarantine'; then
  echo "Failed to remove com.apple.quarantine from $TARGET" >&2
  exit 1
fi

echo "Removed com.apple.quarantine from $TARGET"
