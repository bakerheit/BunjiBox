# Native Computer-Use Methods Spike

Research snapshot: 2026-09-22. Scope is a compile-only macOS spike plus deterministic tests. No app, capture session, permission prompt, screen, or input event was run.

## Result

Candidate native path: list user-shareable windows with ScreenCaptureKit, filter a stream to the selected window, and render its frames in the sidebar. When the sidebar closes, keep the same stream alive and present its view in a floating AppKit panel. Use a second transparent, click-through panel for an agent-drawn cursor; keep preview controls in the interactive panel. This separates the visible agent marker from the real system pointer.

`experiments/computer-use-native/` compiles the capture, panel, Accessibility, and event-posting API references. `SCStreamOutput` is supplied by the caller; frame-to-view rendering, stream startup, and panel presentation are not implemented or run here. The cursor panel draws no cursor itself: the host view must draw the synthetic marker.

## Verified

- Apple documents `SCShareableContent` for discovering displays, apps, and windows, `SCContentFilter(desktopIndependentWindow:)` for selecting one window, and `SCStream` output/start/stop APIs. Its sample describes a Screen Recording prompt on first use. The spike compiles these entry points but never calls them.
- `NSPanel` supports nonactivating style, floating level, cross-app/full-screen collection behavior, and `ignoresMouseEvents`. The prototype sets `hidesOnDeactivate = false` because panels otherwise hide when BunjiBox deactivates. API compilation does not prove actual Space, Stage Manager, or full-screen behavior.
- Apple describes AppKit screen frames and Quartz display bounds in different coordinate systems. The pure mapping requires a matched display frame, flips Y within that display, keeps event points in points, and scales only display-local backing pixels. Tests cover top-left/bottom-left, 2x backing scale, points outside a display, and a monitor with negative X and Y origins. Real display layouts and mixed-scale monitor transitions remain untested; rebuild mappings by display ID when screen parameters change.
- The session gate accepts only the current `(sessionID, generation)` and strictly increasing sequence numbers. Pause and stop reject work; restarting creates a generation that invalidates queued commands from the old run.
- macOS exposes separate preflight checks for Screen Recording, Accessibility trust, and posted-event access. Apple’s privacy docs list full internal storage and Accessibility as distinct grants, and document Screen & System Audio Recording separately. Full Disk Access is not a substitute for either capture or control approval.

## Inferred

- **Sidebar to PiP:** reparenting the existing preview view into a persistent, nonactivating `NSPanel` is the smallest native route. Keep the stream alive while swapping surfaces; add visible pause/stop controls to the interactive panel. The click-through overlay must be a separate panel so it cannot eat user clicks.
- **AX vs. CGEvent:** Accessibility is semantic: address an app’s AX tree and request an action the element supports. That is the better candidate for background actions because it does not depend on moving the pointer. Apple’s API does not promise that every app will perform an action while inactive; unsupported elements, modal UI, or a hung app can fail. Treat background AX success as app-specific, not guaranteed.
- `CGEvent.post(tap:)` enters the Quartz event stream; `CGEvent.postToPid(_:)` names a target process. Apple’s public references do not define reliable background-window behavior or promise that posting to a PID bypasses foreground/focus rules. Use a foreground controlled app as the initial playback contract. Background CGEvent control is unproven here.
- The “agent cursor” should be a rendered overlay, not the macOS pointer. It can show intent without moving or hiding the human’s pointer. A separate, explicit takeover action should stop the gate first, invalidate queued work, clear/hide the marker, then route control to the user. Automatic takeover on arbitrary human input would need event listening/Input Monitoring; this spike does not request it.

## Blocked / Not Tested

- No real ScreenCaptureKit stream, accessibility action, CGEvent, event tap, GUI, permission prompt, or cursor overlay was run. Permission state is unknown and no OS permission changed.
- Cross-app overlays, fullscreen behavior, capture exclusions, secure/protected content, and foreground/background input behavior need the main agent’s manual QA.
- `swift test` could not use XCTest: the selected Command Line Tools SDK has no XCTest module, and the installed Xcode toolchain asks for its license. No system switch or license change was made. Instead, `swift build --disable-sandbox` compiled the standalone package and `swift run --disable-sandbox ComputerUseNativeSpikeChecks` passed all 19 pure assertions. SwiftPM emitted harmless warnings because its user-level cache is read-only in this worktree.

## Handoff Contract

Put the gate at the final native command executor, not only in the model/network layer. Every command carries its lease and sequence; validate it immediately before dispatch. A user pause, stop, or takeover must synchronously change gate state and flush queued commands. Begin the next agent run with a new generation. For global human-input detection, check/listen permissions separately; an explicit BunjiBox takeover control avoids needing a global event tap.

## Apple Sources

- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [ScreenCaptureKit capture sample and permission flow](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos?language=objc)
- [SCShareableContent](https://developer.apple.com/documentation/screencapturekit/scshareablecontent?changes=_5)
- [SCContentFilter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter)
- [SCStream.addStreamOutput](https://developer.apple.com/documentation/screencapturekit/scstream/addstreamoutput%28_%3Atype%3Asamplehandlerqueue%3A%29?changes=_3_9)
- [SCStream.startCapture](https://developer.apple.com/documentation/screencapturekit/scstream/startcapture%28completionhandler%3A%29)
- [NSWindow style masks](https://developer.apple.com/documentation/appkit/nswindow/stylemask-swift.struct?changes=_3)
- [NSPanel floating behavior](https://developer.apple.com/documentation/appkit/nspanel/isfloatingpanel)
- [NSWindow.hidesOnDeactivate](https://developer.apple.com/documentation/appkit/nswindow/hidesondeactivate?changes=_7)
- [NSWindow.canJoinAllApplications](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct/canjoinallapplications)
- [NSWindow.ignoresMouseEvents](https://developer.apple.com/documentation/appkit/nswindow/ignoresmouseevents?changes=_5___7&language=objc)
- [NSScreen coordinate frames and backing conversions](https://developer.apple.com/documentation/appkit/nsscreen?changes=_4)
- [NSWindow screen-space origin](https://developer.apple.com/documentation/appkit/nswindow/setframeorigin%28_%3A%29)
- [CGDisplayBounds](https://developer.apple.com/documentation/coregraphics/cgdisplaybounds%28_%3A%29?changes=_8&language=objc)
- [Core Graphics geometry units](https://developer.apple.com/documentation/coregraphics/cggeometry?language=objc)
- [AXUIElement.h and trust checks](https://developer.apple.com/documentation/applicationservices/axuielement_h)
- [AXUIElementPerformAction](https://developer.apple.com/documentation/applicationservices/1462091-axuielementperformaction?language=objc)
- [AXUIElementCopyElementAtPosition coordinates](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition?changes=_2_2&language=objc)
- [AXIsProcessTrustedWithOptions](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions?preferredLanguage=occ)
- [CGEvent.post(tap:)](https://developer.apple.com/documentation/coregraphics/cgevent/post%28tap%3A%29?changes=_2)
- [CGEventPostToPid](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid%28_%3A%29?changes=_2_8_1&language=objc)
- [CGPreflightPostEventAccess](https://developer.apple.com/documentation/coregraphics/cgpreflightposteventaccess%28%29?language=objc)
- [CGPreflightListenEventAccess](https://developer.apple.com/documentation/coregraphics/cgpreflightlisteneventaccess%28%29?changes=_6_7)
- [CGPreflightScreenCaptureAccess](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess%28%29?changes=lat_3__2_4_1_1&language=objc)
- [Apple security: file, full-storage, and Accessibility access](https://support.apple.com/en-ca/guide/security/secddd1d86a6/web)
- [Apple user guide: screen and system audio recording](https://support.apple.com/en-ke/guide/mac-help/mchld6aa7d23/mac)
