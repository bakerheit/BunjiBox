import Foundation

@MainActor
final class BunjiServiceController {
    private var process: Process?

    func ensureRunning(api: BunjiAPI) async throws {
        if (try? await api.health()) != nil { return }
        guard let repository = repositoryURL() else {
            throw BunjiAPIError.server("Bunji service is offline. Set BUNJI_REPO_ROOT or start `npm run api`.")
        }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["npm", "run", "api"]
        task.currentDirectoryURL = repository
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try task.run()
        process = task
        for _ in 0..<40 {
            try await Task.sleep(for: .milliseconds(150))
            if (try? await api.health()) != nil { return }
        }
        throw BunjiAPIError.server("Bunji service did not start. Run `npm run api` in the BunjiBox repository.")
    }

    private func repositoryURL() -> URL? {
        let manager = FileManager.default
        if let explicit = ProcessInfo.processInfo.environment["BUNJI_REPO_ROOT"],
           manager.fileExists(atPath: explicit + "/apps/server/server.mjs") {
            return URL(fileURLWithPath: explicit, isDirectory: true)
        }
        let common = manager.homeDirectoryForCurrentUser.appending(path: "workspace/BunjiBox", directoryHint: .isDirectory)
        if manager.fileExists(atPath: common.appending(path: "apps/server/server.mjs").path) { return common }
        var current = URL(fileURLWithPath: manager.currentDirectoryPath, isDirectory: true)
        while current.path != "/" {
            if manager.fileExists(atPath: current.appending(path: "apps/server/server.mjs").path) { return current }
            current.deleteLastPathComponent()
        }
        return nil
    }
}
