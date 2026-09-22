# Bunji computer-use research and spikes

These are isolated experiments, **not computer-use features enabled in BunjiBox**.
Three workers were requested as `gpt-5.6-luna` with `model_reasoning_effort="max"`
through the installed Codex CLI, in separate Git worktrees. The normal subagent
launcher rejected Luna. The CLI accepted the jobs but warned that Luna's local
model metadata was missing. Treat this as a model/runtime caveat, not a benchmark.

## Recommended direction

Keep **one session owner**, with three separate pieces:

| Piece | First candidate | Evidence so far |
| --- | --- | --- |
| App-owned browser | A session-owned WKWebView displayed in a docked pane or floating NSPanel | Three pure state checks; real local-page reparenting passed UI checks |
| Mac apps | ScreenCaptureKit window frames, Accessibility actions where supported, a separate drawn cursor overlay | Public API code compiles; 19 coordinate/control assertions pass; no real capture/input executed |
| Model tools | A narrow, scoped stdio MCP bridge for the existing Codex/Claude harnesses | Six fake-frame contract tests pass; image round-trip through both subscribed harnesses remains unverified |

The system-design skill informed this split: model orchestration, native execution,
and visible surfaces have separate ownership. OpenAI Docs informed the distinction
between a desktop feature and an exposed integration. The first-party built-in
browser is a [desktop feature, not a CLI browser](https://learn.chatgpt.com/docs/browser).
Its existence does not grant Bunji access to the same implementation.

For native apps, a floating preview and an agent-drawn pointer are separate from the
human's system pointer. Background interaction must be tested per app; the compiled
APIs do not prove ChatGPT-level background behavior. macOS screen-recording and
accessibility grants remain separate from Bunji's filesystem full-access setting.
Do not restore pairing or an approval inbox as a prerequisite; retain the user's
explicit access choice and a clear stop/takeover control.

Keep Chromium/Playwright as the alternative if WKWebView compatibility or browser
automation fidelity becomes the blocker. An extension is a third option for an
existing browser profile, not a way to embed Chrome's side panel inside Bunji.
Jev's reviewed official material does not establish visual computer control.

## Screenshot evidence

The user supplied four screenshots: a right-pane launcher, a tabbed embedded
browser with an address/navigation bar, and wider/closer views of a floating app
preview over the chat. They support these UI requirements:

- A resizable right work area that can host Files, Browser, Terminal, and other panes.
- Browser chrome with tabs, navigation, and a visible origin.
- A compact floating preview that does not replace or reset the ongoing chat.
- A distinct control indicator on the controlled app; the provided BunjiBox
  appshots show the host's purple badge.

The exact special cursor shape/animation and the trigger between sidebar and PiP
were not established by the static screenshots. The small preview can be present
while the right pane is open; don't assume those surfaces are always exclusive.
Raw screenshots contain private conversation content and were **not copied into
the repository**. The agent could not inspect ChatGPT's own UI because the computer
tool blocks that app in this session; these observations come from user attachments.

The local `BrowserShellDemo` uses a deliberately simulated purple cursor labeled
**Bunji · demo**, not an attempted pixel-perfect copy. The top-left control badge
visible during QA belongs to ChatGPT's computer tool, not the demo.

## Verification

- Browser state: `swift run --package-path experiments/computer-use-browser ComputerUseBrowserSpike` — 3 checks passed.
- Native compile/state: `swift run --package-path experiments/computer-use-native ComputerUseNativeSpikeChecks` — 19 checks passed.
- Bridge: `node --test experiments/computer-use-bridge/contract.test.mjs` — 6 tests passed.
- Visual demo: real WKWebView local fixture, counter incremented, draft entered,
  moved to PiP, interacted there, and redocked. Same page session ID and draft
  survived; counter advanced from 1 to 2. Cursor overlay appeared in PiP.
- No provider computer-use loop, real-screen capture, desktop input injection,
  real-site login, latency comparison, or cross-device remote control was tested.

Command Line Tools lacks XCTest here; the Swift experiments use dependency-free
executable checks. No Xcode license or OS permission was changed.

## Next implementation gate

First, prove one synthetic screenshot + scoped MCP tool round-trip through each
signed-in CLI. Then wire an owned browser to a real bot behind an experimental flag.
Verify click/type/scroll, redirects, login handoff, stale-frame rejection, stop,
takeover, and preservation across pane/PiP changes. Native apps come after that.

Before production, bind actions to actual viewport/window bounds and observation
age, enforce a single writer at the final input dispatcher, and authenticate any
local/native broker. Never expose raw CDP, cookies, or arbitrary native evaluation
over Wi-Fi. These prototypes do not yet implement that production boundary.

Potential improvements over the reference UI to evaluate, not yet implemented:
show the active agent/app, label stale or paused previews, provide one-click takeover,
and show small action-specific highlights without moving the user's pointer.

## Detail

- [Browser methods and live-demo follow-up](browser-methods.md)
- [Native capture, coordinates, control, and cursor methods](native-methods.md)
- [Provider bridge and tool contract](provider-bridge.md)

The experiments live under `experiments/`; no production app/core imports them.
Run `zsh experiments/computer-use-browser/build-demo.sh` to build a standalone local
demo app. It prints a temporary `.app` path; open that path to inspect the fixture.
