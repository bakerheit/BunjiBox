#!/bin/zsh
set -euo pipefail
native_dir="$(cd "$(dirname "$0")" && pwd)"
native_output="$native_dir/.build/lab"
swift build --package-path "$native_dir" --product BunjiNativeLab
native_app="$native_output/Bunji Native Lab.app"
mkdir -p "$native_app/Contents/MacOS"
cp "$native_dir/.build/debug/BunjiNativeLab" "$native_app/Contents/MacOS/BunjiNativeLab"
cp "$native_dir/Lab-Info.plist" "$native_app/Contents/Info.plist"
codesign --force --sign - "$native_app"
printf '%s\n' "$native_app"
