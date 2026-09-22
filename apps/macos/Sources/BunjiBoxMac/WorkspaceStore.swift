import Foundation
import SwiftUI

@MainActor
final class WorkspaceStore: ObservableObject {
    @Published var bots: [Bot] = []
    @Published var selectedBotID: String?
    @Published var requests: [ChatRequest] = []
    @Published var draft = ""
    @Published var errorMessage: String?
    @Published var isConnecting = true
    @Published var isSending = false
    @Published var inspectorTab = InspectorTab.activity
    @Published var editingBot: Bot?

    private let api = BunjiAPI()
    private let service = BunjiServiceController()
    private var pollingTask: Task<Void, Never>?
    private var botsRevision = -1

    var selectedBot: Bot? { bots.first(where: { $0.id == selectedBotID }) }
    var runningRequest: ChatRequest? { requests.last(where: \.isRunning) }

    func start() async {
        guard pollingTask == nil else { return }
        do {
            try await service.ensureRunning(api: api)
            try await reloadBots()
            isConnecting = false
            pollingTask = Task { [weak self] in
                while !Task.isCancelled {
                    try? await self?.refreshBots()
                    await self?.refreshHistory(silent: true)
                    try? await Task.sleep(for: .milliseconds(1200))
                }
            }
        } catch {
            isConnecting = false
            errorMessage = error.localizedDescription
        }
    }

    func reloadBots() async throws {
        try await refreshBots()
        await refreshHistory(silent: true)
    }

    private func apply(_ response: BotListResponse) {
        guard response.revision >= botsRevision else { return }
        botsRevision = response.revision
        bots = response.bots
        if selectedBotID == nil || !bots.contains(where: { $0.id == selectedBotID }) {
            selectedBotID = bots.first?.id
            requests = []
        }
    }

    private func refreshBots() async throws {
        apply(try await api.bots())
    }

    func select(_ bot: Bot) {
        selectedBotID = bot.id
        requests = []
        errorMessage = nil
        Task { await refreshHistory(silent: false) }
    }

    func refreshHistory(silent: Bool = false) async {
        guard let id = selectedBotID else { return }
        do {
            let page = try await api.history(botID: id)
            guard id == selectedBotID else { return }
            requests = page.requests
            if !silent { errorMessage = nil }
        } catch {
            if !silent { errorMessage = error.localizedDescription }
        }
    }

    func send() async {
        guard let bot = selectedBot else { return }
        let prompt = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, runningRequest == nil else { return }
        draft = ""
        isSending = true
        do {
            _ = try await api.send(bot: bot, prompt: prompt)
            await refreshHistory()
        } catch {
            draft = prompt
            errorMessage = error.localizedDescription
        }
        isSending = false
    }

    func cancel() async {
        guard let runningRequest else { return }
        do { _ = try await api.cancel(requestID: runningRequest.id); await refreshHistory() }
        catch { errorMessage = error.localizedDescription }
    }

    func createBot() async {
        do {
            let response = try await api.createBot()
            let oldIDs = Set(bots.map(\.id))
            apply(response)
            if let created = bots.first(where: { !oldIDs.contains($0.id) }) {
                select(created)
                editingBot = created
            }
        } catch { errorMessage = error.localizedDescription }
    }

    func updateSelected(_ changes: BotPatch) async {
        guard let id = selectedBotID else { return }
        await update(botID: id, changes: changes)
    }

    func saveProfile(botID: String, changes: BotPatch) async throws {
        apply(try await api.patch(botID: botID, changes: changes))
    }

    private func update(botID: String, changes: BotPatch) async {
        do {
            try await saveProfile(botID: botID, changes: changes)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func setModel(_ model: String) {
        guard let index = bots.firstIndex(where: { $0.id == selectedBotID }) else { return }
        let bot = bots[index]
        let efforts = RuntimeCatalog.efforts(for: bot.provider, model: model)
        let effort = efforts.contains(bot.effort) ? bot.effort : "medium"
        bots[index].model = model
        bots[index].effort = effort
        Task { await update(botID: bot.id, changes: BotPatch(model: model, effort: effort)) }
    }

    func setEffort(_ effort: String) {
        guard let index = bots.firstIndex(where: { $0.id == selectedBotID }) else { return }
        bots[index].effort = effort
        let id = bots[index].id
        Task { await update(botID: id, changes: BotPatch(effort: effort)) }
    }
}

enum InspectorTab: String, CaseIterable, Identifiable {
    case activity, usage, settings
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}
