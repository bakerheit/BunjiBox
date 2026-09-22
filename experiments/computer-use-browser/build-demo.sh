#!/bin/zsh
set -euo pipefail
spike_dir="$(cd "$(dirname "$0")" && pwd)"
lab_dir="$(mktemp -d -t bunji-browser-lab)"
swift build --package-path "$spike_dir" --scratch-path "$lab_dir/build" --product BrowserShellDemo
lab_app="$lab_dir/Bunji Browser Lab.app"
mkdir -p "$lab_app/Contents/MacOS"
cp "$lab_dir/build/debug/BrowserShellDemo" "$lab_app/Contents/MacOS/BrowserShellDemo"
cp "$spike_dir/Demo-Info.plist" "$lab_app/Contents/Info.plist"
codesign --force --sign - "$lab_app"
printf '%s\n' "$lab_app"
