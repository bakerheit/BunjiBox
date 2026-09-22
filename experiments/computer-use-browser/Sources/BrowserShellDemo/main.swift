import AppKit
import WebKit

@MainActor
final class PreviewPanel: NSPanel {
    override var canBecomeMain: Bool { true }
    override var canBecomeKey: Bool { true }
}

// Local-only visual experiment. No model, capture, external browsing, or input injection.
@MainActor
final class BrowserDemo: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    let window = NSWindow(contentRect: NSRect(x: 160, y: 160, width: 1120, height: 740), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
    let panel = PreviewPanel(contentRect: NSRect(x: 960, y: 120, width: 410, height: 320), styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
    let browserHost = NSView()
    let surface = NSView()
    let cursor = CursorOverlay()
    let web: WKWebView
    let stateLabel = NSTextField(labelWithString: "Browser docked · local fixture · no model connected")
    let dock = NSButton(title: "Float preview", target: nil, action: nil)
    var floating = false

    override init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: config)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        window.title = "Bunji Browser Lab — isolated prototype"
        window.delegate = self
        window.minSize = NSSize(width: 860, height: 520)
        panel.title = "Bunji live preview · demo"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.minSize = NSSize(width: 320, height: 240)
        panel.delegate = self
        panel.isReleasedWhenClosed = false
        let content = window.contentView!
        let row = NSStackView()
        row.orientation = .horizontal
        row.spacing = 12
        dock.target = self; dock.action = #selector(toggleDock)
        let showCursor = NSButton(title: "Show demo cursor", target: self, action: #selector(toggleCursor))
        let takeOver = NSButton(title: "Take over / stop demo", target: self, action: #selector(stopDemo))
        [dock, showCursor, takeOver, stateLabel].forEach { row.addArrangedSubview($0) }
        row.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(row)
        let split = NSSplitView()
        split.isVertical = true
        split.dividerStyle = .thin
        split.translatesAutoresizingMaskIntoConstraints = false
        let notes = NSTextField(wrappingLabelWithString: "BunjiBox\n\nBrowser + PiP experiment\n\n1. Click the counter in the browser.\n2. Float the preview.\n3. Dock it again.\n\nThe count and page session ID must stay unchanged.\n\nThe purple pointer is a simulated visual overlay. It does not move your mouse or control the page.\n\nOnly a local HTML fixture can load in this demo. No model or desktop permissions are connected.")
        notes.font = .systemFont(ofSize: 16)
        let left = NSView()
        notes.translatesAutoresizingMaskIntoConstraints = false
        left.addSubview(notes)
        split.addArrangedSubview(left); split.addArrangedSubview(browserHost)
        content.addSubview(split)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: content.topAnchor, constant: 14),
            row.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -16),
            split.topAnchor.constraint(equalTo: row.bottomAnchor, constant: 14),
            split.leadingAnchor.constraint(equalTo: content.leadingAnchor), split.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            split.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            left.widthAnchor.constraint(greaterThanOrEqualToConstant: 300),
            notes.topAnchor.constraint(equalTo: left.topAnchor, constant: 24), notes.leadingAnchor.constraint(equalTo: left.leadingAnchor, constant: 24),
            notes.trailingAnchor.constraint(equalTo: left.trailingAnchor, constant: -24),
        ])
        web.navigationDelegate = self
        web.autoresizingMask = [.width, .height]
        cursor.autoresizingMask = [.width, .height]
        surface.autoresizingMask = [.width, .height]
        surface.addSubview(web); surface.addSubview(cursor)
        web.loadHTMLString("""
        <!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><style>
        html{color-scheme:dark}body{margin:0;background:#121214;color:#eee;font:16px -apple-system;padding:28px;line-height:1.5}h1{font-size:28px}button{font:inherit;padding:12px 18px;color:#fff;background:#7557ee;border:0;border-radius:12px;cursor:pointer}code{font-size:12px;word-break:break-all}.card{padding:22px;border:1px solid #39383e;border-radius:18px;margin:20px 0}p{color:#b8b8c4}
        </style><h1>Same page. Different surface.</h1><p>This is a local test page, not a remote browser session.</p>
        <div class="card"><button onclick="document.getElementById('count').textContent=++window.demoCount">Increment counter</button><h2>Count: <span id="count">0</span></h2><p>Page session: <code id="session"></code></p><input aria-label="Persistent draft" placeholder="Type a draft; it should stay here" style="width:100%;box-sizing:border-box;padding:12px"></div>
        <p>Float and dock the view. Neither the counter nor your draft should reset.</p><script>window.demoCount=0;document.getElementById('session').textContent=Date.now().toString(36)+Math.random().toString(36).slice(2);</script></html>
        """, baseURL: nil)
        attach(to: browserHost)
        window.makeKeyAndOrderFront(nil)
        split.setPosition(420, ofDividerAt: 0)
        NSApp.activate(ignoringOtherApps: true)
    }

    func attach(to host: NSView) {
        surface.removeFromSuperview()
        surface.frame = host.bounds
        web.frame = surface.bounds; cursor.frame = surface.bounds
        host.addSubview(surface)
    }

    @objc func toggleDock() {
        floating.toggle()
        if floating {
            attach(to: panel.contentView!)
            panel.makeKeyAndOrderFront(nil)
        } else {
            attach(to: browserHost)
            panel.orderOut(nil)
        }
        dock.title = floating ? "Dock preview" : "Float preview"
        stateLabel.stringValue = floating ? "Same page in PiP · no reload" : "Browser docked · same page session"
    }

    @objc func toggleCursor() { cursor.visible.toggle(); cursor.needsDisplay = true }
    @objc func stopDemo() {
        cursor.visible = false; cursor.needsDisplay = true
        stateLabel.stringValue = "You have control · simulated cursor stopped"
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === panel { if floating { toggleDock() }; return false }
        NSApp.terminate(nil); return true
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        // No arbitrary website/native JS bridge is exposed by this local visual fixture.
        decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
    }
}

@MainActor
final class CursorOverlay: NSView {
    var visible = false
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        guard visible else { return }
        let p = NSPoint(x: bounds.width * 0.60, y: bounds.height * 0.55)
        NSColor.systemPurple.withAlphaComponent(0.18).setFill()
        NSBezierPath(ovalIn: NSRect(x: p.x - 19, y: p.y - 19, width: 38, height: 38)).fill()
        let arrow = NSBezierPath()
        arrow.move(to: p); arrow.line(to: NSPoint(x: p.x + 6, y: p.y - 24)); arrow.line(to: NSPoint(x: p.x + 11, y: p.y - 15)); arrow.line(to: NSPoint(x: p.x + 23, y: p.y - 13)); arrow.close()
        NSColor.systemPurple.setFill(); arrow.fill()
        NSColor.white.setStroke(); arrow.lineWidth = 1.5; arrow.stroke()
        ("Bunji · demo" as NSString).draw(at: NSPoint(x: p.x + 25, y: p.y - 24), withAttributes: [.foregroundColor: NSColor.systemPurple, .font: NSFont.boldSystemFont(ofSize: 12)])
    }
}

let application = NSApplication.shared
let delegate = BrowserDemo()
application.delegate = delegate
application.run()
