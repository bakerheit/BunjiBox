import Foundation

struct BotListResponse: Decodable, Sendable {
    let revision: Int
    let bots: [Bot]
}

struct Bot: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var name: String
    var description: String
    var provider: String
    var model: String
    var effort: String
    var mode: String
    var avatar: BotAvatar
    var computer: ComputerAccess
}

struct BotAvatar: Codable, Hashable, Sendable {
    var shape: String
    var color: String
    var image: String?

    // PATCH merges avatar fields, so clearing a picture requires an explicit null.
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(shape, forKey: .shape)
        try values.encode(color, forKey: .color)
        try values.encode(image, forKey: .image)
    }
}

struct ComputerAccess: Codable, Hashable, Sendable {
    var scope: String
    var level: String
    var network: String
    var folder: String?
}

struct HistoryPage: Decodable, Sendable {
    let revision: Int
    let requests: [ChatRequest]
    let hasMore: Bool
    let nextBefore: String?
}

struct ChatRequest: Decodable, Identifiable, Sendable {
    let id: String
    let prompt: String
    let provider: String
    let model: String
    let effort: String
    let requestedMode: String?
    let mode: String
    let modeReason: String?
    let startedAt: Int64
    let status: String
    let text: String
    let activities: [RunActivity]
    let usage: TokenUsage?
    let usageBreakdown: UsageBreakdown?
    let durationMs: Int?
    let error: String?
    let contextTurns: Int?
    let omittedTurns: Int?

    var isRunning: Bool { status == "running" }
}

struct RunActivity: Decodable, Identifiable, Sendable {
    let id: String
    let kind: String?
    let title: String
    let status: String
    let text: String?
    let input: String?
    let output: String?
}

struct TokenUsage: Decodable, Sendable {
    let inputTokens: Int?
    let outputTokens: Int?
    let cachedInputTokens: Int?
    let cacheWriteTokens: Int?
    let reasoningOutputTokens: Int?
    let totalTokens: Int?
    let source: String?
}

struct UsageBreakdown: Decodable, Sendable {
    let calls: Int?
    let userMessage: TextMeasurement?
    let bunjiContext: ContextMeasurement?
    let providerHarnessUnknown: HarnessMeasurement?
}

struct TextMeasurement: Decodable, Sendable {
    let characters: Int?
    let words: Int?
    let estimatedTokens: Int?
}

struct ContextMeasurement: Decodable, Sendable {
    let characters: Int?
    let estimatedTokens: Int?
    let historyTurns: Int?
}

struct HarnessMeasurement: Decodable, Sendable {
    let estimatedTokens: Int?
    let status: String?
    let reason: String?
}

struct SendMessageRequest: Encodable, Sendable {
    let id: String
    let prompt: String
    let provider: String
    let model: String
    let effort: String
    let mode: String
    let memoryWrite: Bool
}

struct SendMessageResponse: Decodable, Sendable { let request: ChatRequest }
struct CancelResponse: Decodable, Sendable { let request: ChatRequest }

struct CreateBotRequest: Encodable, Sendable {
    let id: String
    let name: String
    let description: String
    let provider: String
    let model: String
    let effort: String
    let mode: String
    let avatar: BotAvatar
    let computer: ComputerAccess
}

struct BotPatch: Encodable, Sendable {
    var name: String?
    var description: String?
    var provider: String?
    var model: String?
    var effort: String?
    var mode: String?
    var avatar: BotAvatar?
}

enum RuntimeCatalog {
    static let providers = ["codex", "claude", "openrouter", "ollama"]
    static let labels = ["codex": "Codex", "claude": "Claude", "openrouter": "OpenRouter", "ollama": "Ollama · Pi"]
    static let models: [String: [(id: String, label: String)]] = [
        "codex": [("gpt-6-astra", "GPT-6 Astra"), ("gpt-5.6-sol", "GPT-5.6 Sol"), ("gpt-5.6-terra", "GPT-5.6 Terra"), ("gpt-5.6-luna", "GPT-5.6 Luna"), ("gpt-5.5", "GPT-5.5")],
        "claude": [("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")],
        "openrouter": [("openrouter/free", "Free Model Router"), ("openrouter/auto", "Auto Router")],
        "ollama": [("gemma3:1b", "Gemma3 1B · Raspberry Pi"), ("qwen3:1.7b", "Qwen3 1.7B · Raspberry Pi")],
    ]

    static func automaticMode(for provider: String) -> String {
        ["codex", "claude"].contains(provider) ? "auto" : "chat"
    }

    static func efforts(for provider: String, model: String) -> [String] {
        if provider == "ollama" { return ["low", "medium"] }
        if provider == "openrouter" { return ["low", "medium", "high"] }
        var values = ["low", "medium", "high", "xhigh"]
        if model != "gpt-5.5" { values.append("max") }
        if provider == "codex" && ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"].contains(model) { values.append("ultra") }
        return values
    }

    static func modelLabel(provider: String, model: String) -> String {
        models[provider]?.first(where: { $0.id == model })?.label ?? model
    }
}
