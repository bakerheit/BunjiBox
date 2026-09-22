# BunjiBox for macOS

Native SwiftUI client for the shared Bunji workspace. It talks to the same local
API as the web app and `bunji`, so agents, models, messages, activity, and token
usage stay synchronized.

Click an agent's name or avatar in the chat header, right-click it in the sidebar,
or choose **Edit profile…** in Settings to edit its name, description, and avatar.
Choose from the shared shapes/colors, use the starter picture, or upload a PNG,
JPG, or WebP up to 5 MB. Changes save to the shared workspace; Cancel discards the
draft. Uploaded pictures are center-cropped and resized to 256 × 256.

```bash
npm run macos:build
npm run macos:app
npm run macos:check
open apps/macos/dist/BunjiBox.app
```

The app checks `http://127.0.0.1:4318` and starts `npm run api` from the BunjiBox
repository when needed. Set `BUNJI_REPO_ROOT` if the repository is elsewhere.

This alpha uses Swift Package Manager so it builds with Apple Command Line Tools.
Open the package in full Xcode later for signing, app icons, sandbox entitlements,
and notarized distribution.
