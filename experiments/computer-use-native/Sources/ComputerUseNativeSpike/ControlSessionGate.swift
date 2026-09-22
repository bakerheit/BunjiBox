import Foundation

public struct SessionLease: Equatable, Sendable {
    public let sessionID: String
    public let generation: UInt64

    public init(sessionID: String, generation: UInt64) {
        self.sessionID = sessionID
        self.generation = generation
    }
}

public struct SequencedCommand: Equatable, Sendable {
    public let lease: SessionLease
    public let sequence: UInt64

    public init(lease: SessionLease, sequence: UInt64) {
        self.lease = lease
        self.sequence = sequence
    }
}

public struct ControlSessionGate: Sendable {
    public enum State: Equatable, Sendable {
        case stopped
        case paused
        case running
    }

    public private(set) var state: State = .stopped
    public private(set) var currentLease: SessionLease?
    private var generation: UInt64 = 0
    private var lastAcceptedSequence: UInt64?

    public init() {}

    @discardableResult
    public mutating func start(sessionID: String) -> SessionLease {
        generation &+= 1
        let lease = SessionLease(sessionID: sessionID, generation: generation)
        currentLease = lease
        lastAcceptedSequence = nil
        state = .running
        return lease
    }

    @discardableResult
    public mutating func pause() -> Bool {
        guard state == .running else { return false }
        state = .paused
        return true
    }

    @discardableResult
    public mutating func resume() -> Bool {
        guard state == .paused else { return false }
        state = .running
        return true
    }

    public mutating func stop() {
        state = .stopped
    }

    public mutating func accepts(_ command: SequencedCommand) -> Bool {
        guard state == .running,
              command.lease == currentLease,
              lastAcceptedSequence.map({ command.sequence > $0 }) ?? true else {
            return false
        }
        lastAcceptedSequence = command.sequence
        return true
    }
}
