# BunjiBox for macOS

Native SwiftUI client for the shared Bunji workspace. It talks to the same local
API as the web app and `bunji`, so agents, modes, messages, activity, and token
usage stay synchronized.

```bash
npm run macos:build
npm run macos:app
open apps/macos/dist/BunjiBox.app
```

The app checks `http://127.0.0.1:4318` and starts `npm run api` from the BunjiBox
repository when needed. Set `BUNJI_REPO_ROOT` if the repository is elsewhere.

This alpha uses Swift Package Manager so it builds with Apple Command Line Tools.
Open the package in full Xcode later for signing, app icons, sandbox entitlements,
and notarized distribution.
