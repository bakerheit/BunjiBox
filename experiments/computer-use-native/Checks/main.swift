import ComputerUseNativeSpike
import Foundation

func check(_ condition: Bool, _ name: String) {
    precondition(condition, "FAILED: \(name)")
    print("PASS: \(name)")
}

@main
enum ComputerUseNativeSpikeChecks {
    static func main() throws {
        let primary = try DisplayCoordinateMap(
            displayID: 1,
            appKitFrame: DesktopRect(x: 0, y: 0, width: 1440, height: 900),
            quartzFrame: DesktopRect(x: 0, y: 0, width: 1440, height: 900),
            backingScale: 1
        )
        check(
            try primary.toQuartz(DesktopPoint(x: 120, y: 80)) == DesktopPoint(x: 120, y: 820),
            "AppKit bottom-left to Quartz top-left conversion"
        )
        check(
            try primary.toAppKit(DesktopPoint(x: 120, y: 820)) == DesktopPoint(x: 120, y: 80),
            "Quartz to AppKit conversion round trip"
        )

        let retina = try DisplayCoordinateMap(
            displayID: 2,
            appKitFrame: DesktopRect(x: 0, y: 0, width: 1440, height: 900),
            quartzFrame: DesktopRect(x: 0, y: 0, width: 1440, height: 900),
            backingScale: 2
        )
        check(
            try retina.toQuartz(DesktopPoint(x: 100.25, y: 100)) == DesktopPoint(x: 100.25, y: 800),
            "Retina event point stays in logical points"
        )
        check(
            try retina.toLocalPixels(DesktopPoint(x: 100.25, y: 100)) == DesktopPoint(x: 200.5, y: 1600),
            "Retina backing scale applies to local pixel coordinates"
        )

        let leftDisplay = try DisplayCoordinateMap(
            displayID: 3,
            appKitFrame: DesktopRect(x: -1280, y: 800, width: 1280, height: 600),
            quartzFrame: DesktopRect(x: -1280, y: -600, width: 1280, height: 600),
            backingScale: 1
        )
        check(
            try leftDisplay.toQuartz(DesktopPoint(x: -1200, y: 900)) == DesktopPoint(x: -1200, y: -100),
            "Negative x and y monitor origins use matched display bounds"
        )
        check(
            try leftDisplay.toLocalPixels(DesktopPoint(x: -1200, y: 900)) == DesktopPoint(x: 80, y: 500),
            "Negative desktop origin does not leak into local pixels"
        )

        do {
            _ = try primary.toQuartz(DesktopPoint(x: -1, y: 50))
            check(false, "Points outside a display are rejected")
        } catch CoordinateError.pointOutsideDisplay {
            check(true, "Points outside a display are rejected")
        }

        var gate = ControlSessionGate()
        let lease = gate.start(sessionID: "agent-a")
        let mismatched = SessionLease(sessionID: "agent-b", generation: lease.generation)
        check(
            !gate.accepts(SequencedCommand(lease: mismatched, sequence: 1)),
            "Mismatched session lease is rejected"
        )
        check(gate.accepts(SequencedCommand(lease: lease, sequence: 2)), "Current session command is accepted")
        check(
            !gate.accepts(SequencedCommand(lease: lease, sequence: 2)),
            "Replayed sequence is rejected"
        )
        check(
            !gate.accepts(SequencedCommand(lease: lease, sequence: 1)),
            "Out-of-order sequence is rejected"
        )

        check(gate.pause(), "Running session pauses")
        check(
            !gate.accepts(SequencedCommand(lease: lease, sequence: 3)),
            "Paused session rejects commands"
        )
        check(gate.resume(), "Paused session resumes")
        check(gate.accepts(SequencedCommand(lease: lease, sequence: 3)), "Resumed session accepts newer commands")
        gate.stop()
        check(
            !gate.accepts(SequencedCommand(lease: lease, sequence: 4)),
            "Stopped session rejects commands"
        )

        let nextLease = gate.start(sessionID: "agent-a")
        check(nextLease.generation != lease.generation, "Restart creates a new generation")
        check(
            !gate.accepts(SequencedCommand(lease: lease, sequence: 4)),
            "Old generation is rejected after restart"
        )
        check(
            gate.accepts(SequencedCommand(lease: nextLease, sequence: 1)),
            "New generation starts with a fresh sequence"
        )
        var observation = ObservationGuard(maxAge: 10, maxActions: 2)
        let generation = observation.generation
        _ = try observation.record(id: "frame-a", width: 100, height: 50, startedGeneration: generation, now: 100)
        check(try observation.validate(id: "frame-a", now: 105, x: 99, y: 49).width == 100, "Real image bounds accepted")
        func rejects(_ name: String, _ operation: () throws -> Void) {
            do { try operation(); check(false, name) } catch { check(true, name) }
        }
        rejects("Image right edge excluded") { _ = try observation.validate(id: "frame-a", now: 105, x: 100, y: 10) }
        rejects("NaN coordinates rejected") { _ = try observation.validate(id: "frame-a", now: 105, x: .nan, y: 10) }
        rejects("Missing coordinate rejected") { _ = try observation.validate(id: "frame-a", now: 105, x: 10) }
        rejects("Stale frame age rejected") { _ = try observation.validate(id: "frame-a", now: 111) }
        rejects("Clock reversal rejected") { _ = try observation.validate(id: "frame-a", now: 99) }
        try observation.consume(id: "frame-a", now: 105)
        rejects("Consumed frame cannot replay") { try observation.consume(id: "frame-a", now: 105) }
        observation.pause()
        rejects("Capture completing after takeover rejected") { _ = try observation.record(id: "racy", width: 100, height: 50, startedGeneration: generation, now: 106) }
        observation.resumeFromUI()
        rejects("Pre-takeover generation rejected after resume") { _ = try observation.record(id: "racy", width: 100, height: 50, startedGeneration: generation, now: 106) }
        _ = try observation.record(id: "frame-b", width: 100, height: 50, startedGeneration: observation.generation, now: 107)
        try observation.consume(id: "frame-b", now: 108)
        _ = try observation.record(id: "frame-c", width: 100, height: 50, startedGeneration: observation.generation, now: 109)
        rejects("Session action cap enforced") { try observation.consume(id: "frame-c", now: 110) }
        observation.stop(); observation.resumeFromUI()
        check(observation.stopped && !observation.running, "Stop cannot be resumed, including from UI")
    }
}
