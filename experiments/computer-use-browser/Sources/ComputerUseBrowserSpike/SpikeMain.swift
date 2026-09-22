import Foundation

@main
struct SpikeMain {
    static func main() async throws {
        try await testPresentationKeepsSessionAndCursorStream()
        try await testCancelRejectsStaleEvents()
        try await testTakeoverRejectsOldRunActions()
        print("PASS: 3 browser session invariants")
    }

    private static func testPresentationKeepsSessionAndCursorStream() async throws {
        let session = BrowserSession()
        let sessionID = session.id
        var events = await session.events().makeAsyncIterator()
        guard let runID = await session.beginAgentRun() else {
            throw CheckFailure(description: "Expected an agent run to start")
        }

        await session.present(on: .floating)
        await session.present(on: .hidden)
        await session.present(on: .sidebar)

        let surface = await session.currentSurface()
        let active = await session.isActive(runID: runID)
        let actionID = UUID()
        let accepted = await session.sendCursorEvent(
            runID: runID,
            actionID: actionID,
            action: .move,
            point: CursorPoint(x: 0.25, y: 0.75)
        )
        let event = await events.next()

        try check(session.id == sessionID, "Presentation changes replaced the browser session")
        try check(surface == .sidebar, "Surface did not return to the sidebar")
        try check(active, "Surface changes stopped the active run")
        try check(accepted, "Active run cursor event was rejected")
        try check(
            event == .cursor(
                runID: runID,
                actionID: actionID,
                action: .move,
                point: CursorPoint(x: 0.25, y: 0.75)
            ),
            "Cursor event did not reach the stream"
        )
    }

    private static func testCancelRejectsStaleEvents() async throws {
        let session = BrowserSession()
        var events = await session.events().makeAsyncIterator()
        guard let runID = await session.beginAgentRun() else {
            throw CheckFailure(description: "Expected an agent run to start")
        }

        let cancelled = await session.cancel(runID: runID)
        let active = await session.isActive(runID: runID)
        let accepted = await session.sendCursorEvent(runID: runID, action: .click)
        let event = await events.next()
        let nextRunID = await session.beginAgentRun()

        try check(cancelled, "Cancel did not stop the active run")
        try check(!active, "Cancelled run remained active")
        try check(!accepted, "Cancelled run emitted a stale action")
        try check(event == .runStopped(runID: runID, reason: .cancelled), "Cancel event was missing")
        try check(nextRunID != nil && nextRunID != runID, "Session could not start a new run")
    }

    private static func testTakeoverRejectsOldRunActions() async throws {
        let session = BrowserSession()
        var events = await session.events().makeAsyncIterator()
        guard let oldRunID = await session.beginAgentRun() else {
            throw CheckFailure(description: "Expected an agent run to start")
        }

        let takeover = await session.takeOverByUser()
        let staleClickAccepted = await session.sendCursorEvent(runID: oldRunID, action: .click)
        let takeoverEvent = await events.next()
        guard let newRunID = await session.beginAgentRun() else {
            throw CheckFailure(description: "Expected a new run after user takeover")
        }
        let staleTypeAccepted = await session.sendCursorEvent(runID: oldRunID, action: .type)
        let actionID = UUID()
        let newActionAccepted = await session.sendCursorEvent(
            runID: newRunID,
            actionID: actionID,
            action: .move
        )
        let cursorEvent = await events.next()

        try check(takeover, "User takeover was not accepted")
        try check(!staleClickAccepted && !staleTypeAccepted, "Old run retained control after takeover")
        try check(
            takeoverEvent == .runStopped(runID: oldRunID, reason: .userTakeover),
            "Takeover event was missing"
        )
        try check(newActionAccepted, "New run could not emit cursor event")
        try check(
            cursorEvent == .cursor(runID: newRunID, actionID: actionID, action: .move, point: nil),
            "Cursor stream did not accept the new run"
        )
    }

    private static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw CheckFailure(description: message) }
    }
}

struct CheckFailure: Error, CustomStringConvertible {
    let description: String
}
