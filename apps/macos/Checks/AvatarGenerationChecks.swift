import Foundation
import ImageIO

@main
struct AvatarGenerationChecks {
    @MainActor
    static func wait(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(8)
        while !predicate() {
            precondition(ContinuousClock.now < deadline, "Generation check timed out")
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    @MainActor
    static func main() async throws {
        let api = BunjiAPI(baseURL: URL(string: CommandLine.arguments[1])!)
        func store(_ prompt: String) -> AvatarGenerationStore {
            let value = AvatarGenerationStore(api: api, pollInterval: .milliseconds(20))
            value.prompt = prompt
            return value
        }

        let invalid = store("   ")
        precondition(!invalid.canGenerate)
        invalid.prompt = String(repeating: "x", count: 2001)
        precondition(!invalid.canGenerate)
        invalid.prompt = String(repeating: "x", count: 2000)
        precondition(invalid.canGenerate)

        // Creation may have been accepted despite a dropped connection or unreadable response.
        for prompt in ["create-retry", "transport-retry", "server-retry"] {
            let retry = store(prompt)
            retry.generate()
            try await wait { !retry.isBusy }
            if retry.phase == .failed {
                precondition(retry.hasPendingRequest && retry.prompt == prompt)
                retry.generate()
                try await wait { !retry.isBusy }
            }
            precondition(retry.phase == .ready && retry.preview != nil)
        }

        let poll = store("poll-retry")
        poll.generate()
        try await wait { poll.phase == .failed }
        precondition(poll.hasPendingRequest && poll.preview == nil)
        poll.generate()
        try await wait { !poll.isBusy }
        precondition(poll.phase == .ready)

        for prompt in ["poll-expired", "poll-expired-after-retry"] {
            let expired = store(prompt)
            expired.generate()
            try await wait { expired.phase == .failed }
            if prompt == "poll-expired-after-retry" {
                precondition(expired.hasPendingRequest)
                expired.generate()
                try await wait { expired.phase == .failed }
            }
            precondition(!expired.hasPendingRequest && expired.canGenerate)
            precondition(expired.prompt == prompt && expired.preview == nil)
            precondition(expired.error?.contains("expired") == true)
            expired.generate()
            try await wait { !expired.isBusy }
            precondition(expired.phase == .ready && expired.error == nil)
        }

        let rejected = store("create-rejected")
        rejected.generate()
        try await wait { rejected.phase == .failed }
        precondition(!rejected.hasPendingRequest && rejected.canGenerate)
        precondition(rejected.prompt == "create-rejected" && rejected.error == "Please revise the prompt.")
        rejected.prompt = "create-corrected"
        rejected.generate()
        try await wait { !rejected.isBusy }
        precondition(rejected.phase == .ready)

        let missingCancel = store("cancel-expired")
        missingCancel.generate()
        try await Task.sleep(for: .milliseconds(50))
        missingCancel.cancel()
        try await wait { !missingCancel.isBusy }
        precondition(missingCancel.phase == .cancelled && missingCancel.error == nil)
        precondition(!missingCancel.hasPendingRequest && missingCancel.canGenerate)
        precondition(missingCancel.prompt == "cancel-expired" && missingCancel.preview == nil)
        missingCancel.generate()
        try await wait { !missingCancel.isBusy }
        precondition(missingCancel.phase == .ready)

        let terminal = store("terminal-failure")
        terminal.generate()
        try await wait { terminal.phase == .failed }
        precondition(!terminal.hasPendingRequest && terminal.prompt == "terminal-failure")
        precondition(terminal.error == "Please sign in to ChatGPT through Codex.")
        terminal.generate()
        try await wait { terminal.phase == .ready }

        let badImage = store("invalid-image")
        badImage.generate()
        try await wait { badImage.phase == .failed }
        precondition(badImage.preview == nil && !badImage.hasPendingRequest)
        precondition(badImage.prompt == "invalid-image" && badImage.error != nil)

        let cancel = store("cancel-retry")
        cancel.generate()
        try await Task.sleep(for: .milliseconds(50))
        cancel.cancel()
        try await wait { cancel.phase == .cancelFailed }
        precondition(cancel.preview == nil && cancel.hasPendingRequest)
        cancel.cancel()
        try await wait { cancel.phase == .cancelled }
        precondition(!cancel.hasPendingRequest && cancel.prompt == "cancel-retry")

        let dismissed = store("dismiss-late-result")
        dismissed.generate()
        try await Task.sleep(for: .milliseconds(50))
        dismissed.dismiss()
        try await wait { dismissed.phase == .cancelled }
        precondition(dismissed.preview == nil && !dismissed.canGenerate)

        // Leaving Generate cancels without dismissing the store; returning can start a fresh run.
        let tabChange = store("tab-change-late-result")
        tabChange.generate()
        try await Task.sleep(for: .milliseconds(50))
        tabChange.cancel()
        precondition(tabChange.preview == nil && !tabChange.canGenerate)
        try await wait { tabChange.phase == .cancelled }
        precondition(tabChange.preview == nil && tabChange.prompt == "tab-change-late-result")
        precondition(tabChange.canGenerate && !tabChange.hasPendingRequest)
        tabChange.generate()
        try await wait { !tabChange.isBusy }
        precondition(tabChange.phase == .ready && tabChange.preview != nil)

        let longRun = store("keep-polling")
        longRun.generate()
        try await Task.sleep(for: .seconds(1))
        precondition(longRun.phase == .running)
        longRun.dismiss()
        try await wait { longRun.phase == .cancelled }

        var raw = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        raw.append(Data(count: 6 * 1024 * 1024 - raw.count))
        let normalized = try AvatarImageData.normalizeGenerated("data:image/png;base64," + raw.base64EncodedString())
        precondition(normalized.count <= 350000)
        let bytes = Data(base64Encoded: String(normalized.split(separator: ",")[1]))!
        let source = CGImageSourceCreateWithData(bytes as CFData, nil)!
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)! as NSDictionary
        precondition(properties[kCGImagePropertyPixelWidth] as? Int == 256)
        precondition(properties[kCGImagePropertyPixelHeight] as? Int == 256)
        do { _ = try AvatarImageData.normalize(raw); preconditionFailure("Upload limit changed") }
        catch AvatarImageError.tooLarge {}
        let oversized = Data(count: 20 * 1024 * 1024 + 1)
        do {
            _ = try AvatarImageData.normalizeGenerated("data:image/png;base64," + oversized.base64EncodedString())
            preconditionFailure("Oversized generated image accepted")
        } catch AvatarImageError.generatedTooLarge {}
        print("Native avatar generation checks passed.")
    }
}
