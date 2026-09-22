import ApplicationServices
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

@MainActor
public enum NativeSurfaceAPIs {
    public static func makeWindowStream(
        window: SCWindow,
        output: any SCStreamOutput,
        delegate: any SCStreamDelegate,
        outputQueue: DispatchQueue
    ) throws -> SCStream {
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let stream = SCStream(
            filter: filter,
            configuration: SCStreamConfiguration(),
            delegate: delegate
        )
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: outputQueue)
        return stream
    }

    public static func startCapture(_ stream: SCStream) async throws {
        try await stream.startCapture()
    }

    public static func stopCapture(_ stream: SCStream) async throws {
        try await stream.stopCapture()
    }

    public static func makePreviewPanel(contentView: NSView, frame: NSRect) -> NSPanel {
        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.contentView = contentView
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        return panel
    }

    public static func makeClickThroughCursorPanel(contentView: NSView, frame: NSRect) -> NSPanel {
        let panel = NSPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.contentView = contentView
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        return panel
    }

    public static func accessibilityTrustStatus() -> Bool {
        AXIsProcessTrusted()
    }

    public static func screenCaptureTrustStatus() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    public static func eventPostingTrustStatus() -> Bool {
        CGPreflightPostEventAccess()
    }

    public static func accessibilityElement(for processID: pid_t) -> AXUIElement {
        AXUIElementCreateApplication(processID)
    }

    public static func performAccessibilityAction(
        on element: AXUIElement,
        action: CFString
    ) -> AXError {
        AXUIElementPerformAction(element, action)
    }

    public static func postEvent(_ event: CGEvent, to processID: pid_t) {
        event.postToPid(processID)
    }
}
