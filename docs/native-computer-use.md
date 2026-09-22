# Basic native computer use

Normal saved-bot chat can now expose the existing guarded native MCP helper to
Codex and Claude. Apple Notes and the disposable fixture are the only targets.
Main validated real Notes capture, new-note creation, text insertion, and AX
read-back; integrate its separate focused-first AX traversal fix alongside this
change. This branch does not change the native executor or its target allowlist.

## Setup

Run from the checkout that serves the backend:

```sh
npm run macos:app
open apps/macos/dist/BunjiBox.app
```

The app build also builds and signs the native helper in this checkout. The
checkout-backed backend must run from this same checkout; copying only the app
bundle does not install a standalone backend or its helper. `swift build` alone
only compiles the main app; use `npm run macos:app` for the complete build.

In the native app's agent Settings, click **Enable This Mac full access…** for
a saved Codex or Claude bot and confirm once. This uses the dedicated server
confirmation endpoint and replaces any folder limit. No web app or pairing is
needed. Then, in the same Settings panel,
choose **Native control → Apple Notes** and confirm. The picker persists
`nativeComputer: "com.apple.Notes"` through the existing bot PATCH API. Older bots
default to `off`. Folder access cannot enable native control. An unsupported
target is rejected. The setting never changes filesystem or OS permissions.

Ask in normal chat: `Open Notes and write a new note titled Bunji test.` Auto
routes native requests to Agent. Explicit Chat remains tool-free. A missing
helper build produces an actionable error before the provider launches.

The helper opens its own visible preview window during Agent turns. Capture is
a snapshot refreshed by Observe, not video. **Take over** pauses and invalidates
frames; only the human **Resume** button can return control. **Stop** is terminal
for that helper process. Cancelling the chat ends the provider; MCP disconnect or
pipe EOF closes the helper. Turning the setting off affects future turns; cancel
an active turn separately. A later Agent turn creates a new helper session.

Notes requires Accessibility and Screen Recording for **Bunji Native Lab**. The
helper reports the real OS state. Permission requests remain user-clicked helper
UI actions. An OS grant on one build/machine does not prove another has it.

## Runtime and validation

Only saved bot settings reach the runner; run payloads cannot inject a helper or
native target. Native turns use one-shot Codex execution even when experimental
persistent sessions are enabled. Both providers retain memory/files MCP tools.
Claude gets `ENABLE_TOOL_SEARCH=false` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`
only in its native-enabled child environment so its small tool set initializes
before the turn. No global CLI settings are edited.

```sh
node --test packages/core/test/*.test.mjs packages/shared/test/*.test.mjs apps/server/src/*.test.mjs
BUNJI_NATIVE_EXPERIMENT=1 node --test experiments/computer-use-native-bridge/test/bridge.test.mjs
swift run --package-path experiments/computer-use-native ComputerUseNativeSpikeChecks
node --test apps/macos/Checks/*.test.mjs
swift build --package-path apps/macos
```

The native runtime tests require the helper build for positive config tests;
without it those tests skip explicitly. Saved-chat integration uses a stubbed
provider and real command generation, not paid model calls or GUI input. Bridge
tests use a fake helper. Main owns real app/chat UI QA, Notes smoke testing,
provider end-to-end checks and any backend restart. No backend was restarted here.

Remaining limits: no generic app support, continuous video, or background input
guarantee. Native control is intentionally restricted to already-confirmed
full-machine bots; their existing unrestricted shell permissions are unchanged.
