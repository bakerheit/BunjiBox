import Foundation

/// Final-dispatch guard, independent of the model/transport. Time is monotonic.
public struct ObservationGuard {
    public struct Frame: Equatable {
        public let id: String
        public let generation: UInt64
        public let width: Int
        public let height: Int
        public let capturedAt: TimeInterval
    }
    public private(set) var generation: UInt64 = 0
    public private(set) var running = true
    public private(set) var stopped = false
    public private(set) var latest: Frame?
    public private(set) var actionCount = 0
    public let maxAge: TimeInterval
    public let maxActions: Int

    public init(maxAge: TimeInterval = 60, maxActions: Int = 100) {
        self.maxAge = maxAge; self.maxActions = maxActions
    }
    public mutating func invalidate() { generation &+= 1; latest = nil }
    public mutating func pause() { running = false; invalidate() }
    public mutating func stop() { stopped = true; pause() }
    public mutating func resumeFromUI() {
        guard !stopped else { return }
        running = true; invalidate()
    }
    public mutating func record(id: String, width: Int, height: Int, startedGeneration: UInt64, now: TimeInterval) throws -> Frame {
        guard running, !stopped, generation == startedGeneration, width > 0, height > 0, now.isFinite else {
            throw GuardError.invalidObservation
        }
        let frame = Frame(id: id, generation: generation, width: width, height: height, capturedAt: now)
        latest = frame
        return frame
    }
    public func validate(id: String, now: TimeInterval, x: Double? = nil, y: Double? = nil) throws -> Frame {
        guard running, !stopped else { throw GuardError.notRunning }
        guard let f = latest, f.id == id, f.generation == generation else { throw GuardError.staleFrame }
        guard now.isFinite, now >= f.capturedAt, now - f.capturedAt <= maxAge else { throw GuardError.staleFrame }
        guard actionCount < maxActions else { throw GuardError.actionLimit }
        if x != nil || y != nil {
            guard let x, let y, x.isFinite, y.isFinite, x >= 0, y >= 0, x < Double(f.width), y < Double(f.height) else { throw GuardError.outsideFrame }
        }
        return f
    }
    public mutating func consume(id: String, now: TimeInterval, x: Double? = nil, y: Double? = nil) throws {
        _ = try validate(id: id, now: now, x: x, y: y)
        latest = nil; actionCount += 1
    }
    public enum GuardError: String, Error, LocalizedError {
        case invalidObservation = "Observation invalidated during capture; observe again."
        case notRunning = "Native session paused or stopped. Only the user can resume it in the lab."
        case staleFrame = "Observation is stale or consumed. Observe again before acting."
        case actionLimit = "Native session action limit reached."
        case outsideFrame = "Coordinates are outside the observed image."
        public var errorDescription: String? { rawValue }
    }
}
