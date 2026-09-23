#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
app_dir=${script_dir:h}
configuration=${CONFIGURATION:-debug}

# The checkout-backed service resolves this helper beside its source tree.
# Build and sign it before packaging so first native chat needs no setup command.
zsh "$app_dir/../../experiments/computer-use-native/build-lab.sh"

swift build --package-path "$app_dir" --configuration "$configuration"
binary=$(swift build --package-path "$app_dir" --configuration "$configuration" --show-bin-path)/BunjiBoxMac
destination="$app_dir/dist/BunjiBox.app"

mkdir -p "$destination/Contents/MacOS" "$destination/Contents/Resources"
cp "$binary" "$destination/Contents/MacOS/BunjiBoxMac"
cp "$app_dir/Resources/Info.plist" "$destination/Contents/Info.plist"
cp "$app_dir/Resources/BunjiBox.icns" "$destination/Contents/Resources/BunjiBox.icns"
cp -R "${binary:h}/BunjiBoxMac_BunjiBoxMac.bundle" "$destination/Contents/Resources/"
chmod +x "$destination/Contents/MacOS/BunjiBoxMac"
codesign --force --deep --sign - "$destination"
echo "$destination"
