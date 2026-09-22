import Foundation

public enum BrowserSurface: Equatable, Sendable {
    case sidebar
    case floating
    case hidden
}

public enum AgentAction: Equatable, Sendable {
    case move
    case click
    case type
    case scroll
}

public struct CursorPoint: Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public enum BrowserActionEvent: Equatable, Sendable {
    case cursor(runID: UUID, actionID: UUID, action: AgentAction, point: CursorPoint?)
    case runStopped(runID: UUID, reason: StopReason)

    public enum StopReason: Equatable, Sendable {
        case cancelled
        case userTakeover
        case completed
    }
}

public actor BrowserSession {
    public nonisolated let id: UUID

    private var surface: BrowserSurface = .sidebar
    private var activeRunID: UUID?
    private let eventStream: AsyncStream<BrowserActionEvent>
    private let eventContinuation: AsyncStream<BrowserActionEvent>.Continuation

    public init(id: UUID = UUID()) {
        let channel = AsyncStream.makeStream(of: BrowserActionEvent.self)
        self.id = id
        self.eventStream = channel.stream
        self.eventContinuation = channel.continuation
    }

    public func events() -> AsyncStream<BrowserActionEvent> {
        eventStream
    }

    public func currentSurface() -> BrowserSurface {
        surface
    }

    public func present(on surface: BrowserSurface) {
        self.surface = surface
    }

    public func beginAgentRun() -> UUID? {
        guard activeRunID == nil else { return nil }
        let runID = UUID()
        activeRunID = runID
        return runID
    }

    @discardableResult
    public func sendCursorEvent(
        runID: UUID,
        actionID: UUID = UUID(),
        action: AgentAction,
        point: CursorPoint? = nil
    ) -> Bool {
        guard activeRunID == runID else { return false }
        eventContinuation.yield(.cursor(runID: runID, actionID: actionID, action: action, point: point))
        return true
    }

    @discardableResult
    public func cancel(runID: UUID) -> Bool {
        stop(runID: runID, reason: .cancelled)
    }

    @discardableResult
    public func takeOverByUser() -> Bool {
        guard let runID = activeRunID else { return false }
        return stop(runID: runID, reason: .userTakeover)
    }

    @discardableResult
    public func complete(runID: UUID) -> Bool {
        stop(runID: runID, reason: .completed)
    }

    public func isActive(runID: UUID) -> Bool {
        activeRunID == runID
    }

    private func stop(runID: UUID, reason: BrowserActionEvent.StopReason) -> Bool {
        guard activeRunID == runID else { return false }
        activeRunID = nil
        eventContinuation.yield(.runStopped(runID: runID, reason: reason))
        return true
    }
}
