import Foundation

@main
struct NativeAccessChecks {
    static func main() async throws {
        let api = BunjiAPI(baseURL: URL(string: CommandLine.arguments[1])!)
        let id = "native-access-check"
        let initial = try await api.bots().bots.first { $0.id == id }!
        precondition(initial.computer.scope == "none")
        do {
            _ = try await api.patch(botID: id, changes: BotPatch(nativeComputer: "com.apple.Notes"))
            preconditionFailure("Native control must require confirmed machine access")
        } catch BunjiAPIError.http(let status, _) { precondition(status == 409) }
        _ = try await api.confirmFullMachine(botID: id, network: "off")
        let confirmed = try await BunjiAPI(baseURL: api.baseURL).bots().bots.first { $0.id == id }!
        precondition(confirmed.computer.scope == "machine" && confirmed.computer.level == "auto")
        precondition(confirmed.computer.network == "off" && confirmed.computer.folder == nil)
        precondition(confirmed.nativeComputer == "off", "Machine confirmation must not implicitly enable native control")
        _ = try await api.patch(botID: id, changes: BotPatch(nativeComputer: "com.apple.Notes"))
        do {
            _ = try await api.confirmFullMachine(botID: id, network: "invalid")
            preconditionFailure("Invalid policy accepted")
        } catch BunjiAPIError.http(let status, _) { precondition(status == 400) }
        let saved = try await api.bots().bots.first { $0.id == id }!
        precondition(saved.nativeComputer == "com.apple.Notes" && saved.computer.network == "off")
        print("Native full-access confirmation and separate target opt-in checks passed.")
    }
}
