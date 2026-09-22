import AppKit
@preconcurrency import ApplicationServices
import ComputerUseNativeSpike
import Foundation
import ScreenCaptureKit
import Carbon

struct LabError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

@MainActor
final class LabPreviewPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

@MainActor
final class NativeLab: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let target: String
    let stdio: Bool
    let window = NSWindow(contentRect: NSRect(x: 100, y: 150, width: 820, height: 620), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    let fixture = NSWindow(contentRect: NSRect(x: 960, y: 250, width: 540, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let panel = LabPreviewPanel(contentRect: NSRect(x: 960, y: 60, width: 390, height: 290), styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
    let preview = NSImageView()
    let previewHost = NSView()
    let statusLabel = NSTextField(wrappingLabelWithString: "Starting native lab…")
    let detailLabel = NSTextField(wrappingLabelWithString: "No observation yet")
    let draft = NSTextField(string: "")
    let savedLabel = NSTextField(wrappingLabelWithString: "Nothing saved")
    let save = NSButton(title: "Save draft", target: nil, action: nil)
    let visualCode = "BUNJI-\(Int.random(in: 1000...9999))"
    let cursorView = AgentPointer()
    var cursorPanel: NSPanel?
    var guardState = ObservationGuard()
    var busy = false
    var floating = false
    var snapshotBounds = CGRect.zero
    var snapshotWindow: CGWindowID = 0
    var snapshotPID: pid_t = 0
    var observedAXWindow: AXUIElement?
    var elements: [String: AXUIElement] = [:]
    var monitors: [Any] = []
    var lockFD: Int32 = -1
    var stdinSource: DispatchSourceRead?
    var inputBuffer = Data()
    var recentIDs = Set<String>()
    var startupError: String?
    static let eventTag: Int64 = 0x42554E4A49

    init(target: String, stdio: Bool) { self.target = target; self.stdio = stdio; super.init() }
    var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildUI()
        do { try acquireLease() }
        catch { guardState.stop(); startupError = error.localizedDescription }
        let mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .keyDown, .scrollWheel]
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] event in
            guard event.cgEvent?.getIntegerValueField(.eventSourceUserData) != Self.eventTag else { return }
            MainActor.assumeIsolated { self?.takeOver() }
        }) { monitors.append(monitor) }
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            MainActor.assumeIsolated {
                if event.window === self?.fixture { self?.takeOver() }
            }
            return event
        }) { monitors.append(monitor) }
        refreshStatus()
        if stdio { startInput() }
    }

    func acquireLease() throws {
        // One native executor per OS user, even if multiple MCP clients launch helpers.
        let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/BunjiNativeLab")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attrs = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard (attrs[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(), attrs[.type] as? FileAttributeType == .typeDirectory,
              let mode = attrs[.posixPermissions] as? NSNumber, mode.intValue & 0o077 == 0 else { throw LabError("Unsafe native lab lease directory.") }
        lockFD = open(directory.appendingPathComponent("executor.lock").path, O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw LabError("Another Bunji Native Lab owns computer control. Close it first.") }
        var metadata = stat()
        guard fstat(lockFD, &metadata) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFREG else { throw LabError("Unsafe native executor lease file.") }
    }

    func buildUI() {
        window.title = "Bunji Native Lab — experimental"
        window.delegate = self; window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 720, height: 460)
        panel.title = "Bunji · native preview"
        panel.delegate = self; panel.isReleasedWhenClosed = false
        panel.level = .floating; panel.hidesOnDeactivate = false
        let accessory = NSTitlebarAccessoryViewController()
        let takeover = NSButton(title: "Take over", target: self, action: #selector(takeOver))
        takeover.bezelStyle = .rounded; takeover.sizeToFit()
        accessory.view = takeover; accessory.layoutAttribute = .right
        panel.addTitlebarAccessoryViewController(accessory)
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 12
        root.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Native control · \(target == "fixture" ? "disposable fixture" : target)")
        title.font = .boldSystemFont(ofSize: 20)
        let row = NSStackView()
        for (label, action) in [("Observe", #selector(observeFromUI)), ("Float / dock", #selector(toggleDock)), ("Take over", #selector(takeOver)), ("Resume", #selector(resume)), ("Stop", #selector(stop))] {
            row.addArrangedSubview(NSButton(title: label, target: self, action: action))
        }
        let permission = NSButton(title: "Request macOS permissions…", target: self, action: #selector(requestPermissions))
        permission.isHidden = target == "fixture"
        [title, row, statusLabel, permission, previewHost, detailLabel].forEach { root.addArrangedSubview($0) }
        let content = window.contentView!; content.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20), root.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            root.topAnchor.constraint(equalTo: content.topAnchor, constant: 20), root.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -20),
            previewHost.widthAnchor.constraint(equalTo: root.widthAnchor), previewHost.heightAnchor.constraint(greaterThanOrEqualToConstant: 220)
        ])
        preview.imageScaling = .scaleProportionallyUpOrDown
        preview.autoresizingMask = [.width, .height]
        preview.wantsLayer = true; preview.layer?.backgroundColor = NSColor.black.cgColor
        attachPreview(to: previewHost)
        let menu = NSMenu(); let appMenu = NSMenu(); let item = NSMenuItem(); item.submenu = appMenu; menu.addItem(item)
        appMenu.addItem(withTitle: "Quit Bunji Native Lab", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        NSApp.mainMenu = menu
        if target == "fixture" { buildFixture() }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }

    func buildFixture() {
        fixture.title = "Bunji disposable native note"
        fixture.delegate = self; fixture.isReleasedWhenClosed = false
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 20
        root.frame = NSRect(x: 24, y: 24, width: 490, height: 290)
        let title = NSTextField(labelWithString: "Native note fixture")
        title.font = .boldSystemFont(ofSize: 24)
        draft.placeholderString = "Write a test note here"; draft.setAccessibilityLabel("Draft text")
        draft.widthAnchor.constraint(equalToConstant: 480).isActive = true
        save.target = self; save.action = #selector(saveDraft)
        [title, NSTextField(labelWithString: "Visual code: \(visualCode)"), NSTextField(wrappingLabelWithString: "A real AppKit window. Data stays in memory; Apple Notes is untouched."), draft, save, savedLabel].forEach { root.addArrangedSubview($0) }
        fixture.contentView!.addSubview(root); fixture.orderFront(nil)
    }
    @objc func saveDraft() { savedLabel.stringValue = "Saved: \(draft.stringValue)" }
    func attachPreview(to view: NSView) { preview.removeFromSuperview(); preview.frame = view.bounds; view.addSubview(preview) }
    @objc func toggleDock() {
        floating.toggle(); attachPreview(to: floating ? panel.contentView! : previewHost)
        if floating { panel.makeKeyAndOrderFront(nil) } else { panel.orderOut(nil); window.makeKeyAndOrderFront(nil) }
    }
    @objc func takeOver() { guardState.pause(); cursorPanel?.orderOut(nil); detailLabel.stringValue = "Paused · old frames invalidated."; refreshStatus() }
    @objc func resume() {
        guardState.resumeFromUI()
        detailLabel.stringValue = guardState.running ? "Observe again before acting." : "Stopped · start a new lab session."
        refreshStatus()
    }
    @objc func stop() { guardState.stop(); cursorPanel?.orderOut(nil); detailLabel.stringValue = "Stopped · old frames invalidated."; refreshStatus() }
    @objc func requestPermissions() {
        // Only a direct user click triggers OS permission prompts. Never requested by MCP.
        CGRequestScreenCaptureAccess()
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        refreshStatus()
    }
    func status() -> [String: Any] {
        ["target": target, "state": guardState.stopped ? "stopped" : guardState.running ? "running" : "user-control", "actions": guardState.actionCount,
         "screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted(), "fixture": target == "fixture", "experimental": true,
         "fixtureSavedMatchesVisualCode": target == "fixture" && savedLabel.stringValue == "Saved: \(visualCode)", "startupError": startupError ?? ""]
    }
    func refreshStatus() {
        let state = guardState.stopped ? "Stopped — restart the lab to begin again" : guardState.running ? "Agent control · Take over pauses pending actions" : "You have control · click Resume to hand back"
        statusLabel.stringValue = state + (target == "fixture" ? "\nFixture actions only; no OS permissions needed." : "\nExternal apps require Screen Recording and Accessibility. Foreground input only.")
        if let startupError { statusLabel.stringValue = startupError }
        preview.alphaValue = guardState.running ? 1 : 0.45
        panel.title = guardState.stopped ? "Bunji · stopped snapshot" : guardState.running ? "Bunji · native snapshot" : "Bunji · paused snapshot"
    }
    @objc func observeFromUI() {
        guard !busy else { return }; busy = true
        Task { defer { busy = false }; do { _ = try await observe() } catch { detailLabel.stringValue = error.localizedDescription } }
    }

    func app() throws -> NSRunningApplication {
        guard let application = NSRunningApplication.runningApplications(withBundleIdentifier: target).first, !application.isTerminated else { throw LabError("Target is not open. Use native_focus first.") }
        return application
    }
    func focus() async throws -> [String: Any] {
        guard guardState.running, !guardState.stopped else { throw LabError("Session is paused or stopped.") }
        guardState.invalidate()
        if target == "fixture" { fixture.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        else {
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target) else { throw LabError("Target app is not installed.") }
            let generation = guardState.generation
            let config = NSWorkspace.OpenConfiguration(); config.activates = false
            let running = try await NSWorkspace.shared.openApplication(at: url, configuration: config)
            guard guardState.running, generation == guardState.generation else { throw LabError("Focus cancelled by user takeover.") }
            guard running.activate(options: []) else { throw LabError("Could not activate target.") }
        }
        return ["focused": target, "next": "Observe before acting."]
    }

    func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value
    }
    func focusedWindow(_ application: NSRunningApplication) throws -> AXUIElement {
        let root = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.25)
        guard let value = axValue(root, kAXFocusedWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { throw LabError("No accessible focused target window.") }
        return unsafeDowncast(value, to: AXUIElement.self)
    }
    func axBounds(_ element: AXUIElement) -> CGRect? {
        guard let p = axValue(element, kAXPositionAttribute), let s = axValue(element, kAXSizeAttribute), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var position = CGPoint.zero; var size = CGSize.zero
        guard AXValueGetValue(unsafeDowncast(p, to: AXValue.self), .cgPoint, &position), AXValueGetValue(unsafeDowncast(s, to: AXValue.self), .cgSize, &size) else { return nil }
        return CGRect(origin: position, size: size)
    }
    func sameBounds(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1 && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
    }
    func snapshotAX(_ root: AXUIElement, pid: pid_t, bounds: CGRect) -> [[String: Any]] {
        elements.removeAll()
        var result: [[String: Any]] = []; var visited = Set<CFHashCode>(); let deadline = now + 0.75
        // A long sidebar must not consume the entire budget before the editor.
        // Prefer the focused element, then traverse breadth-first across panes.
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        let appRoot = AXUIElementCreateApplication(pid)
        if let focused = axValue(appRoot, kAXFocusedUIElementAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() {
            let element = unsafeDowncast(focused, to: AXUIElement.self)
            if let elementBounds = axBounds(element), bounds.contains(elementBounds) { queue.insert((element, 0), at: 0) }
        }
        var offset = 0
        while offset < queue.count && result.count < 60 && now < deadline {
            let (e, depth) = queue[offset]; offset += 1
            guard depth < 9, visited.insert(CFHash(e)).inserted else { continue }
            let role = axValue(e, kAXRoleAttribute) as? String ?? "unknown"
            let subrole = axValue(e, kAXSubroleAttribute) as? String ?? ""
            if subrole == kAXSecureTextFieldSubrole { continue }
            let id = "e\(result.count)"; elements[id] = e
            let label = axValue(e, kAXTitleAttribute) as? String ?? axValue(e, kAXDescriptionAttribute) as? String ?? ""
            let value = axValue(e, kAXValueAttribute) as? String ?? ""
            result.append(["id": id, "role": role, "label": String(label.prefix(160)), "value": String(value.prefix(300))])
            let children = axValue(e, kAXChildrenAttribute) as? [AXUIElement] ?? []
            for child in children.prefix(min(60, max(0, 360 - queue.count))) { queue.append((child, depth + 1)) }
        }
        return result
    }
    func encodeImage(_ image: CGImage) throws -> (Data, NSImage) {
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let data = bitmap.representation(using: .png, properties: [:]), data.count <= 8_000_000 else { throw LabError("Native image could not be encoded within the size limit.") }
        return (data, NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height)))
    }
    func observe() async throws -> [String: Any] {
        guard guardState.running, !guardState.stopped else { throw LabError("Session is paused or stopped.") }
        guardState.invalidate(); let generation = guardState.generation
        let captureStarted = now
        let image: CGImage; let evidence: [[String: Any]]
        if target == "fixture" {
            let view = fixture.contentView!; view.layoutSubtreeIfNeeded()
            guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw LabError("Fixture snapshot unavailable.") }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            NSColor.windowBackgroundColor.setFill(); view.bounds.fill()
            view.displayIgnoringOpacity(view.bounds, in: context)
            NSGraphicsContext.restoreGraphicsState()
            guard let cg = bitmap.cgImage else { throw LabError("Fixture image unavailable.") }; image = cg
            snapshotBounds = fixture.frame; snapshotWindow = CGWindowID(fixture.windowNumber); snapshotPID = getpid()
            evidence = [["id": "draft", "role": "AXTextField", "label": "Draft text", "value": draft.stringValue], ["id": "save", "role": "AXButton", "label": "Save draft", "value": ""], ["id": "saved", "role": "AXStaticText", "label": "Saved result", "value": savedLabel.stringValue]]
        } else {
            guard CGPreflightScreenCaptureAccess(), AXIsProcessTrusted() else { throw LabError("Grant Screen Recording and Accessibility to the native helper using its permissions button, then retry. No permission was requested automatically.") }
            guard !IsSecureEventInputEnabled() else { throw LabError("Secure input is active. Capture is paused until it ends.") }
            let running = try app(); let axWindow = try focusedWindow(running)
            guard let bounds = axBounds(axWindow) else { throw LabError("Could not identify target window bounds.") }
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard guardState.running, generation == guardState.generation else { throw LabError("Observation cancelled by takeover.") }
            let matches = content.windows.filter { $0.owningApplication?.processID == running.processIdentifier && $0.windowLayer == 0 && sameBounds($0.frame, bounds) }
            guard matches.count == 1, let selected = matches.first else { throw LabError("Cannot uniquely match the accessible window to a capture window.") }
            let config = SCStreamConfiguration()
            let scale = min(1, 1400 / max(bounds.width, bounds.height))
            config.width = max(1, Int(bounds.width * scale)); config.height = max(1, Int(bounds.height * scale))
            config.showsCursor = false; config.ignoreShadowsSingleWindow = true
            image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: selected), configuration: config)
            guard guardState.running, generation == guardState.generation, !IsSecureEventInputEnabled(), let currentBounds = axBounds(try focusedWindow(running)), sameBounds(bounds, currentBounds) else { throw LabError("Window moved or session changed during capture. Observe again.") }
            evidence = snapshotAX(axWindow, pid: running.processIdentifier, bounds: bounds)
            snapshotBounds = bounds; snapshotWindow = selected.windowID; snapshotPID = running.processIdentifier
            observedAXWindow = axWindow
        }
        let (png, displayed) = try encodeImage(image)
        let frame = try guardState.record(id: UUID().uuidString, width: image.width, height: image.height, startedGeneration: generation, now: captureStarted)
        preview.image = displayed
        detailLabel.stringValue = "Observed \(target) · \(image.width)×\(image.height) · frame \(frame.id.prefix(8))\nSnapshot, not a live video. Refresh after each action."
        return ["frameId": frame.id, "width": image.width, "height": image.height, "target": target, "windowId": snapshotWindow, "elements": evidence,
                "image": ["mimeType": "image/png", "data": png.base64EncodedString()], "evidenceIsUntrusted": true, "maxFrameAgeSeconds": 60, "capture": target == "fixture" ? "own-AppKit-view" : "ScreenCaptureKit"]
    }

    func validateTarget() throws -> AXUIElement {
        guard AXIsProcessTrusted(), !IsSecureEventInputEnabled() else { throw LabError("Accessibility unavailable or secure input active.") }
        let running = try app()
        guard running.processIdentifier == snapshotPID, NSWorkspace.shared.frontmostApplication?.processIdentifier == snapshotPID else { throw LabError("Target changed or is not foreground. Focus it and observe again.") }
        let focused = try focusedWindow(running)
        guard let observedAXWindow, CFEqual(observedAXWindow, focused), let bounds = axBounds(focused), sameBounds(bounds, snapshotBounds) else { throw LabError("Target window moved or changed. Observe again.") }
        // Check the actual captured window still exists at those coordinates.
        let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, snapshotWindow) as? [[String: Any]] ?? []
        guard let info = windows.first, (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == snapshotPID else { throw LabError("Observed window has closed.") }
        let root = AXUIElementCreateApplication(snapshotPID)
        if let value = axValue(root, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() {
            let element = unsafeDowncast(value, to: AXUIElement.self)
            if axValue(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole { throw LabError("Secure text input is not available to this prototype.") }
        }
        return focused
    }
    func emit(_ event: CGEvent) {
        event.setIntegerValueField(.eventSourceUserData, value: Self.eventTag)
        event.postToPid(snapshotPID)
    }
    func showPointer(at quartz: CGPoint) {
        guard let primary = NSScreen.screens.first else { return }
        let point = CGPoint(x: quartz.x, y: primary.frame.maxY - quartz.y)
        if cursorPanel == nil {
            cursorPanel = NativeSurfaceAPIs.makeClickThroughCursorPanel(contentView: cursorView, frame: NSRect(x: point.x, y: point.y - 50, width: 140, height: 60))
        }
        cursorPanel?.setFrameOrigin(NSPoint(x: point.x - 8, y: point.y - 50))
        cursorPanel?.orderFrontRegardless()
    }
    func act(_ params: [String: Any]) throws -> [String: Any] {
        guard Set(params.keys) == ["frameId", "action"], let frameID = params["frameId"] as? String, let action = params["action"] as? [String: Any], let type = action["type"] as? String else { throw LabError("Invalid action envelope.") }
        let keys: [String: Set<String>] = ["click": ["type", "x", "y"], "press": ["type", "elementId"], "type": ["type", "text"], "key": ["type", "key"], "scroll": ["type", "direction", "amount"]]
        guard keys[type] == Set(action.keys) else { throw LabError("Unsupported action fields.") }
        let frame = try guardState.validate(id: frameID, now: now)
        let text = action["text"] as? String ?? ""
        if type == "type", text.isEmpty || text.utf16.count > 1000 || text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) { throw LabError("Type accepts 1–1000 UTF-16 units of plain text; use key actions for control keys.") }
        let key = action["key"] as? String ?? ""
        let keyCodes: [String: CGKeyCode] = ["return": 36, "tab": 48, "escape": 53, "command+n": 45, "command+a": 0]
        if type == "key", keyCodes[key] == nil { throw LabError("Unsupported key.") }
        var x: Double?; var y: Double?
        if type == "click" {
            x = action["x"] as? Double; y = action["y"] as? Double
            guard let x, let y else { throw LabError("Numeric click coordinates required.") }
            _ = try guardState.validate(id: frameID, now: now, x: x, y: y)
        }
        let elementID = action["elementId"] as? String ?? ""
        if type == "press", elementID.isEmpty { throw LabError("Element ID required.") }
        let amount = action["amount"] as? Int ?? 0; let direction = action["direction"] as? String ?? ""
        if type == "scroll", !(1...600).contains(amount) || !["up", "down"].contains(direction) { throw LabError("Invalid scroll.") }
        if target == "fixture" {
            guard sameBounds(snapshotBounds, fixture.frame), fixture.isVisible else { throw LabError("Fixture moved or closed. Observe again.") }
            if type == "press", !["save", "draft"].contains(elementID) { throw LabError("Fixture element is not actionable.") }
            if type == "scroll" || type == "key" && !["return", "tab", "escape", "command+a"].contains(key) { throw LabError("Action unsupported by fixture.") }
            try guardState.consume(id: frameID, now: now, x: x, y: y)
            switch type {
            case "press": if elementID == "save" { save.performClick(nil) } else { fixture.makeFirstResponder(draft) }
            case "type":
                guard let editor = draft.currentEditor() as? NSTextView, fixture.firstResponder === editor else { throw LabError("Focus the draft field before typing.") }
                editor.insertText(text, replacementRange: editor.selectedRange())
                draft.stringValue = editor.string
            case "key":
                if key == "return" { save.performClick(nil) }
                if key == "tab" { fixture.makeFirstResponder(draft) }
                if key == "command+a" { draft.selectText(nil) }
            case "click":
                let view = fixture.contentView!
                let p = NSPoint(x: x! / Double(frame.width) * view.bounds.width, y: view.bounds.height - y! / Double(frame.height) * view.bounds.height)
                guard let hit = view.hitTest(p) else { throw LabError("No fixture control at that point.") }
                if hit === save { save.performClick(nil) }
                else if hit === draft || hit.isDescendant(of: draft) { fixture.makeFirstResponder(draft) }
                else { throw LabError("Only the fixture draft and save button are actionable.") }
            default: break
            }
            let control = type == "press" && elementID == "save" || type == "key" && key == "return" ? save as NSView : draft as NSView
            let screenRect = fixture.convertToScreen(control.convert(control.bounds, to: nil))
            if let primary = NSScreen.screens.first { showPointer(at: CGPoint(x: screenRect.midX, y: primary.frame.maxY - screenRect.midY)) }
        } else {
            _ = try validateTarget()
            // No await between final guard consumption and native dispatch: stop cannot be queued behind an async action.
            if type == "press" {
                guard let element = elements[elementID], let bounds = axBounds(element), snapshotBounds.contains(bounds) else { throw LabError("Element is stale, out of window, or lacks bounds.") }
                var pid: pid_t = 0
                guard AXUIElementGetPid(element, &pid) == .success, pid == snapshotPID else { throw LabError("Element belongs to another app.") }
                try guardState.consume(id: frameID, now: now)
                let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
                guard result == .success else { throw LabError("Accessibility press failed (\(result.rawValue)). Observe before retrying.") }
                showPointer(at: CGPoint(x: bounds.midX, y: bounds.midY))
            } else {
                let source = CGEventSource(stateID: .privateState)
                var events: [CGEvent] = []
                if type == "click" {
                    let point = CGPoint(x: snapshotBounds.minX + x! / Double(frame.width) * snapshotBounds.width, y: snapshotBounds.minY + y! / Double(frame.height) * snapshotBounds.height)
                    guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left), let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { throw LabError("Could not allocate click events.") }
                    events = [down, up]; showPointer(at: point)
                } else if type == "type" || type == "key" {
                    let code = type == "key" ? keyCodes[key]! : 0
                    guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { throw LabError("Could not allocate keyboard events.") }
                    if type == "type" {
                        let chars = Array(text.utf16)
                        chars.withUnsafeBufferPointer { ptr in down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: ptr.baseAddress!); up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: ptr.baseAddress!) }
                    } else if key.hasPrefix("command+") { down.flags = .maskCommand; up.flags = .maskCommand }
                    events = [down, up]
                } else if type == "scroll" {
                    guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(direction == "up" ? amount : -amount), wheel2: 0, wheel3: 0) else { throw LabError("Could not allocate scroll event.") }
                    event.location = CGPoint(x: snapshotBounds.midX, y: snapshotBounds.midY); events = [event]
                }
                try guardState.consume(id: frameID, now: now, x: x, y: y)
                events.forEach(emit)
            }
        }
        detailLabel.stringValue = "Dispatched \(type) · observe to verify the result."
        return ["dispatched": true, "action": type, "verified": false, "next": "Observe to verify. This result only confirms dispatch."]
    }

    func startInput() {
        let source = DispatchSource.makeReadSource(fileDescriptor: STDIN_FILENO, queue: .main)
        source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.readInput() } }
        stdinSource = source; source.resume()
    }
    func readInput() {
        var buffer = [UInt8](repeating: 0, count: 8192)
        let count = Darwin.read(STDIN_FILENO, &buffer, buffer.count)
        guard count > 0 else { stop(); NSApp.terminate(nil); return }
        inputBuffer.append(contentsOf: buffer.prefix(count))
        if inputBuffer.count > 65_536 { stop(); NSApp.terminate(nil); return }
        while let end = inputBuffer.firstIndex(of: 10) {
            let line = Data(inputBuffer[..<end]); inputBuffer.removeSubrange(...end)
            handle(line)
        }
    }
    func respond(_ id: String, result: [String: Any]? = nil, error: String? = nil) {
        var value: [String: Any] = ["id": id]
        if let result { value["result"] = result }; if let error { value["error"] = error }
        guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
        FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
    }
    func handle(_ data: Data) {
        guard let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let id = request["id"] as? String, !id.isEmpty, id.count <= 128, let method = request["method"] as? String,
              Set(request.keys).isSubset(of: ["id", "method", "params"]), let params = request["params"] as? [String: Any], recentIDs.insert(id).inserted else {
            stop(); NSApp.terminate(nil); return
        }
        if recentIDs.count > 1000 { stop(); respond(id, error: "Request limit reached."); return }
        if method == "stop" { stop(); respond(id, result: status()); return }
        if method == "status" { respond(id, result: status()); return }
        guard !busy else { respond(id, error: "Native helper busy. Wait for the current observation."); return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let result: [String: Any]
                switch method {
                case "focus": result = try await focus()
                case "observe": result = try await observe()
                case "act": result = try act(params)
                default: throw LabError("Unknown native method.")
                }
                respond(id, result: result)
            } catch { respond(id, error: error.localizedDescription) }
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === panel { if floating { toggleDock() }; return false }
        stop(); NSApp.terminate(nil); return false
    }
    func applicationWillTerminate(_ notification: Notification) {
        guardState.stop(); cursorPanel?.orderOut(nil); stdinSource?.cancel()
        monitors.forEach(NSEvent.removeMonitor)
        if lockFD >= 0 { close(lockFD) }
    }
}

@MainActor
final class AgentPointer: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemPurple.withAlphaComponent(0.3).setFill()
        NSBezierPath(ovalIn: NSRect(x: 0, y: 28, width: 24, height: 24)).fill()
        let arrow = NSBezierPath(); arrow.move(to: NSPoint(x: 8, y: 50)); arrow.line(to: NSPoint(x: 10, y: 28)); arrow.line(to: NSPoint(x: 16, y: 35)); arrow.line(to: NSPoint(x: 28, y: 35)); arrow.close()
        NSColor.systemPurple.setFill(); arrow.fill(); NSColor.white.setStroke(); arrow.stroke()
        ("Bunji · agent" as NSString).draw(at: NSPoint(x: 30, y: 25), withAttributes: [.foregroundColor: NSColor.systemPurple, .font: NSFont.boldSystemFont(ofSize: 13)])
    }
}

guard ProcessInfo.processInfo.environment["BUNJI_NATIVE_EXPERIMENT"] == "1" else {
    FileHandle.standardError.write(Data("Native lab is experimental. Set BUNJI_NATIVE_EXPERIMENT=1 to launch.\n".utf8)); exit(1)
}
let args = Array(CommandLine.arguments.dropFirst())
let targetIndex = args.firstIndex(of: "--target")
let target = targetIndex.flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } ?? "fixture"
// This milestone intentionally supports only a disposable fixture and explicitly selected Notes.
guard ["fixture", "com.apple.Notes"].contains(target) else {
    FileHandle.standardError.write(Data("Unsupported prototype target. Use fixture or com.apple.Notes.\n".utf8)); exit(1)
}
let application = NSApplication.shared
let delegate = NativeLab(target: target, stdio: args.contains("--stdio"))
application.delegate = delegate
application.run()
