# Bunji Native Lab

The native computer-use helper. Normal saved-bot chat integration is now available
through an explicit native target setting; see [setup](../../docs/native-computer-use.md).
The design keeps the model bridge, native executor, and visible preview separate.
No HTTP port or Wi-Fi control endpoint is exposed.

## Build / open

From the repository root:

```sh
zsh experiments/computer-use-native/build-lab.sh
BUNJI_NATIVE_EXPERIMENT=1 \
  'experiments/computer-use-native/.build/lab/Bunji Native Lab.app/Contents/MacOS/BunjiNativeLab'
```

The default target is a disposable AppKit note fixture. The draft and saved text
exist only in memory. Closing it does not alter Apple Notes or saved Bunji chats.
Its window can be observed in a docked preview or floating panel. Previews are
**snapshots updated on observe**, not a continuous video stream. The purple pointer
is Bunji's click-through overlay; it is not the human pointer or the host CUA badge.

## Current control surface

The private stdio protocol exposes `status`, `focus`, `observe`, `act`, and `stop`.
Use the [MCP bridge](../computer-use-native-bridge/README.md) for a model connection.
The launcher fixes the target; the model cannot switch apps, grant permissions, or
resume after takeover. Only `fixture` and `com.apple.Notes` are accepted in this
milestone. The external Notes adapter passed a live create/type/read-back test.

Actions: image-pixel click, indexed accessibility press, plain text, bounded scroll,
and a small key allowlist. In the fixture, actions use native AppKit controls and
the field editor. In Notes, the adapter uses Accessibility press and PID-targeted
CGEvents, requires the target to be foreground, and checks its focused window.
No claim of ChatGPT-style background input is made.

Real Notes capture uses a ScreenCaptureKit filter for one uniquely matched window.
It requires Screen Recording and Accessibility. The lab's permissions button can
request those grants only when clicked by the user; MCP never requests them. This
is separate from Bunji's filesystem full-access choice. No pairing or approval
inbox was added. No OS permission was changed during the fixture tests.

## Boundaries and lifecycle

- One OS-user executor lease prevents parallel helpers from fighting for input.
- Observations carry an opaque ID, actual image dimensions, and a monotonic age.
  Frames expire after 60 seconds and are consumed by one attempted dispatch.
- Takeover invalidates pending captures/frames; Resume is local UI only. Stop is
  terminal and requires a new lab process. Stop cannot undo already dispatched input.
- Native dispatch rechecks PID, foreground window, accessible window identity,
  geometry, secure input, session state, frame bounds, and action count.
- External human input monitoring pauses the session; global keyboard monitoring
  depends on OS accessibility permission. This needs further real-device testing.
- Session cap: 100 actions. Text: 1–1000 UTF-16 units without control characters.
  Scroll: up/down, 1–600 pixels. No clipboard, arbitrary shell, or arbitrary keys.
- Screen/AX contents are untrusted data. Metadata is bounded; secure fields are
  omitted and capture/input is refused while secure event input is active.
- EOF closes the native lab. The bridge terminates an unresponsive helper instead
  of retrying uncertain actions. Its short transport deadline is not a chat timeout.

## Verification

```sh
swift run --package-path experiments/computer-use-native ComputerUseNativeSpikeChecks
node experiments/computer-use-native/smoke.mjs
BUNJI_NATIVE_EXPERIMENT=1 node --test experiments/computer-use-native-bridge/test/bridge.test.mjs
```

The Swift runner passed 30 coordinate/session/frame checks. Eight live AppKit
fixture checks passed: image, text including Unicode, button, read-back, bounds,
replay rejection, key allowlist, and stop. Add `--screenshots` to the fixture smoke
runner to save temporary fixture-only PNGs for visual inspection.

The first model test correctly stopped when a screenshot turned black after focus.
The fix redraws the complete AppKit subtree into a fresh graphics context; repeated
frames were visually inspected, not just checked for a PNG signature.

Explicit subscription-backed test (uses the signed-in Codex account):

```sh
node experiments/computer-use-native/model-smoke.mjs
node experiments/computer-use-native/model-smoke.mjs --claude
```

Codex completed the ten-tool test: read a randomized code **only present in the
image**, focus the draft, type it, save, re-observe, verify an independent native
equality check, and stop. The run used `gpt-5.6-luna` at low effort. Other tools,
plugins, shell, web, and persistent session storage were disabled for the test.
No screenshots or provider event logs are committed.

Claude Sonnet 5 at low effort also passed the same ten-tool vision/read-back test.
Its first attempts exposed no native tools while MCP was pending. Setting
`ENABLE_TOOL_SEARCH=false` for this small explicit tool set made initialization
wait for the tools and fixed the test. This setting is confined to the test process;
no user CLI configuration was changed. See the
[official environment-variable reference](https://code.claude.com/docs/en/env-vars).
Authentication was checked: Codex uses ChatGPT; Claude uses claude.ai Max. No API-key
or Bedrock/Vertex environment override was present in those test processes.

Live Notes validation (explicitly creates one new test note):

```sh
BUNJI_NATIVE_EXPERIMENT=1 node experiments/computer-use-native/notes-smoke.mjs --create-test-note
```

Passed on 2026-09-21: real ScreenCaptureKit screenshot, Cmd+N, verify a blank
editor, native Unicode typing, and independent Accessibility text read-back.
The test never selects all or replaces existing note contents. One labeled test
note remains; it is not deleted automatically. OS permissions were already granted.
The first test exposed a depth-first scan budget consumed by a long sidebar;
focused-first, breadth-first traversal now keeps the editor in bounded evidence.

Still unverified: broader Notes workflows, OS permission/relaunch behavior, and
multi-monitor cursor placement. Generic native app support, continuous video,
and browser controls are later work. Codex and Claude shared-chat-service fixture
tests passed; see `chat-smoke.mjs --live` (add `--claude` for Claude).
