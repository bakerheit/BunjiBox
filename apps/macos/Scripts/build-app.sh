#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
app_dir=${script_dir:h}
configuration=${CONFIGURATION:-debug}

swift build --package-path "$app_dir" --configuration "$configuration"
binary=$(swift build --package-path "$app_dir" --configuration "$configuration" --show-bin-path)/BunjiBoxMac
destination="$app_dir/dist/BunjiBox.app"

mkdir -p "$destination/Contents/MacOS" "$destination/Contents/Resources"
cp "$binary" "$destination/Contents/MacOS/BunjiBoxMac"
cp "$app_dir/Resources/Info.plist" "$destination/Contents/Info.plist"
chmod +x "$destination/Contents/MacOS/BunjiBoxMac"
codesign --force --deep --sign - "$destination"
echo "$destination"
