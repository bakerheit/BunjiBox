# BunjiBox browser computer-use spike

## Call

Start with one native `WKWebView` owned by a Swift `BrowserSession`. Show that same view in the app's browser sidebar or in a small floating `NSPanel`; closing either surface hides/detaches the view but does not end the session. Put the highlighted agent cursor in a native overlay above the web view, and feed it typed, run-scoped action events.

This fits the existing SwiftUI macOS client and avoids starting with a second browser runtime. Keep the Node service as the model/task orchestrator; let the macOS app own the web view, its session data, screenshot capture, cursor, and action execution. A narrow local bridge can carry typed requests and results between them. The current API at `127.0.0.1:4318` is already a local Swift-to-Node boundary, but this spike does not add browser routes or an agent loop.

```text
Node task/model loop (not implemented here)
        ⇅ typed, authenticated local messages
Swift BrowserSession (one WKWebView + one website data store)
        ├── Browser sidebar host
        └── Floating NSPanel host
             └── Native cursor overlay ← run-scoped action event stream
```

Keep the floating surface visually small and user-dismissable. This is an AppKit floating utility panel, not the system's video Picture in Picture feature. Apple describes floating panels as suitable for small tool palettes that should stay visible while users work in app windows.

## Option check

| Option | What works | Costs / risks | Fit |
| --- | --- | --- | --- |
| **WKWebView + Swift bridge** | Native SwiftUI host; one live page/view can move between surfaces; WebKit message handlers provide a direct JS/native bridge; Swift can draw the cursor in the same coordinate space. | This is WebKit, not Safari or Chrome with their full extension ecosystem. Cookie state belongs to the configured WebKit data store, so don't expect a logged-in Chrome/Safari session. Bridge code must treat pages as untrusted. | **Best first path** for BunjiBox's native app and its own controlled browser session. |
| **Dedicated Chromium + Playwright/CDP streamed to Swift** | Playwright drives Chromium; the Node process can own the browser/context and stream page images to Swift. A persistent browser/context can outlive presentation changes. Useful if Chromium compatibility or Playwright's automation APIs are a hard requirement. | Separate browser runtime and separate cookie/profile store from `WKWebView`; adds image transport, input coordinate mapping, lifecycle, and more process/security work. Playwright says `connectOverCDP` is Chromium-only and lower fidelity than its Playwright protocol. A CDP endpoint is a highly privileged control surface. | Keep as a later fallback if WebKit compatibility fails or we need browser automation outside the app's own page. Use an isolated, app-owned Chromium profile; do not attach to a user's daily browser. |
| **Existing browser extension** | Chrome's `sidePanel` API is purpose-built for an extension panel alongside a page and can track browser tabs. Best if the product goal is a Chrome companion for browsing in Chrome. | Requires an extension install and browser permissions; it lives in Chrome, not BunjiBox's SwiftUI window. It does not give BunjiBox a native floating panel that hosts the same controlled browser view. | Optional separate Chrome integration, not the native app's browser surface. |

The word “CDP” matters here: it is Chrome DevTools Protocol. Playwright documents `connectOverCDP` only for Chromium. Don't design a WKWebView around a CDP socket; use WebKit's own script-message bridge for that option.

## Session and control rules

- Keep the `WKWebView`, its `WKWebsiteDataStore`, current navigation, and the active-run gate in one long-lived session object. Presentation is only a surface state (`sidebar`, `floating`, `hidden`), not a browser restart.
- Use the default persistent store only when that is the explicit product choice. WebKit also supports a non-persistent store for private sessions. Treat each browser session as its own login context; never silently copy cookies or storage from Safari, Chrome, or Playwright.
- Draw the cursor in native app chrome above the web view. Stream normalized view coordinates plus `runID`, `actionID`, action type, and lifecycle state so resize/reparenting can be mapped to the displayed view. Keep cursor display separate from permission to perform the action.
- Cancel and user takeover must atomically revoke the active `runID`. Reject every later event from that run, even if it was queued before a new run starts. When taking over, user input wins immediately; do not wait for the model request to finish.
- For a real JS bridge, accept a narrow typed message schema, validate the current origin/navigation, and avoid exposing general-purpose native calls or unrestricted script evaluation to arbitrary pages. WebKit supports handlers in a specified content world; use that boundary deliberately.

## Security notes

- A dedicated Playwright context is an isolated browser session with its own cookies and storage. That is useful isolation, but it will not magically inherit the user's native browser login. Explicit storage-state import is possible in Playwright, but exporting/importing auth state is secret handling, not a session-sharing shortcut.
- Chrome's remote-debugging endpoint can grant broad browser control. Chrome changed remote-debugging switches so they require a non-default `--user-data-dir`; Chrome recommends keeping debugging away from real profiles. Never expose a raw CDP port to a phone or the public network.
- If a remote phone preview is added later, stream pixels and broker narrowly scoped actions through an authenticated, encrypted, short-lived session. Require explicit user opt-in, bind it to the current user/session, provide a visible stop/revoke control, and avoid sending cookies, storage state, or a debugging endpoint. A screenshot stream is still sensitive: pages can show private data.
- The public OpenAI API computer-use guide documents a Responses tool/action loop: the app executes returned actions and supplies an updated screenshot. It does not establish that a ChatGPT subscription is a callable API credential. Don't promise a subscription-backed model/API path based on the ChatGPT UI.

## Spike evidence

`experiments/computer-use-browser` is a standalone Swift package with no external dependencies and no GUI/browser code. It tests the session/control seam only:

1. Switching sidebar → floating → hidden → sidebar preserves the session identifier, active run, and cursor event stream.
2. Cancel emits a stop event, rejects stale actions, and permits a fresh run.
3. User takeover emits a stop event, rejects the old run, and accepts a new run's cursor event.

Run it with `swift run --package-path experiments/computer-use-browser`. In this sandbox, validation used `swift run --package-path experiments/computer-use-browser --scratch-path /tmp/bunji-computer-use-browser-build --disable-sandbox`; it built and printed `PASS: 3 browser session invariants`. XCTest was unavailable in the local command-line toolchain, so the package uses a deterministic executable self-check instead.

## Verified / inferred / not done

**Verified from primary docs and repo inspection**

- The app is currently a native SwiftUI macOS client using a three-column `NavigationSplitView`; it talks to a local Node API at `127.0.0.1:4318`.
- WebKit has `WKWebView`, JavaScript message handlers (including reply-capable handlers/content-world selection), and configurable persistent or non-persistent website data stores.
- AppKit exposes floating `NSPanel` behavior for utility palettes. Chrome extensions have a `sidePanel` API. Playwright documents isolated browser contexts and Chromium-only, lower-fidelity CDP connection.
- The Swift state spike compiled and its three invariant checks passed.

**Inferred recommendation**

- Keeping the single WebKit view alive while moving its presentation should retain the page and its configured WebKit session state; actual SwiftUI/AppKit reparenting, sizing, and accessibility behavior still need a GUI prototype and manual QA.
- For this app, Swift should own browser presentation and input arbitration, while Node owns model orchestration. The local transport and message contract need a separate design before wiring anything into the app.

**Not implemented / blocked by the test boundary**

- No model dispatch, browser automation loop, screenshot capture, DOM observation, real `WKWebView`, `NSPanel`, cursor drawing, extension, Chromium process, remote preview, or phone client was built or launched.
- This validates logical cancellation gates only. A real adapter must also cancel its in-flight `Task`/browser operation and serialize the stop barrier with native input; this package does not prove OS/WebKit input preemption.
- No visual, live-screen, login, permission, or remote-network QA was done. Those are intentionally left to the main agent/user under the stated boundary.

## Main-agent visual follow-up

After the Luna worker finished, the main agent added the separate `BrowserShellDemo`
executable in the same experiment package. It uses a real, non-persistent WKWebView
and a local HTML fixture; it does not connect to a model or expose arbitrary URLs.
It moves the same view into an NSPanel and back, and draws a click-through purple
pointer labeled **Bunji · demo**. No desktop event injection or capture occurs.

Live native UI verification passed: incremented the counter, entered `keep this draft`,
floated the view, confirmed the same page session ID/count/draft, clicked the counter
inside PiP, then closed PiP to redock. The count advanced to 2 and both the draft and
page session ID survived. A screenshot of the floating preview was captured in the
task. The small top-left purple badge in that screenshot belongs to the controlling
ChatGPT tool, not this prototype. The in-page labeled pointer is the prototype's own.

This verifies local WKWebView reparenting and drawing only, not remote sites, logins,
background computer control, performance, or model tool integration. The earlier
"not implemented" list describes the worker's state-only spike, before this follow-up.

Build the visual executable with `swift build --package-path experiments/computer-use-browser
--product BrowserShellDemo`. `Demo-Info.plist` is supplied for an ad-hoc local app bundle.
The CLI state checks now require the explicit product:
`swift run --package-path experiments/computer-use-browser ComputerUseBrowserSpike`.

## Primary source links

- OpenAI API, Computer use: https://developers.openai.com/api/docs/guides/tools-computer-use
- Apple, `WKWebView`: https://developer.apple.com/documentation/webkit/wkwebview
- Apple, `WKScriptMessageHandlerWithReply`: https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply
- Apple, `WKWebsiteDataStore`: https://developer.apple.com/documentation/webkit/wkwebsitedatastore
- Apple, `NSPanel.isFloatingPanel`: https://developer.apple.com/documentation/appkit/nspanel/isfloatingpanel
- Apple, floating window level: https://developer.apple.com/documentation/appkit/nswindow/level-swift.struct/floating
- Chrome, side panel API: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- Chrome, remote debugging security changes: https://developer.chrome.com/blog/remote-debugging-port
- Chrome DevTools, existing-session connection warning: https://developer.chrome.com/docs/devtools/agents/get-started/configuration
- Playwright, `BrowserType.connectOverCDP`: https://playwright.dev/docs/api/class-browsertype
- Playwright, browser contexts and isolation: https://playwright.dev/docs/browser-contexts
