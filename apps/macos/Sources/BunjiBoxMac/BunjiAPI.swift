import Foundation

enum BunjiAPIError: LocalizedError {
    case invalidResponse
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse: "Bunji returned an unreadable response."
        case .server(let message): message
        }
    }
}

struct BunjiAPI: Sendable {
    let baseURL: URL

    init(baseURL: URL = URL(string: "http://127.0.0.1:4318")!) {
        self.baseURL = baseURL
    }

    func health() async throws {
        let _: HealthResponse = try await request("/api/health")
    }

    func bots() async throws -> BotListResponse { try await request("/api/bots") }

    func history(botID: String) async throws -> HistoryPage {
        try await request("/api/bots/\(segment(botID))/history?limit=100")
    }

    func send(bot: Bot, prompt: String) async throws -> ChatRequest {
        let payload = SendMessageRequest(
            id: "run-\(UUID().uuidString.lowercased())", prompt: prompt,
            provider: bot.provider, model: bot.model, effort: bot.effort,
            mode: bot.mode, memoryWrite: bot.mode != "chat"
        )
        let response: SendMessageResponse = try await request(
            "/api/bots/\(segment(bot.id))/messages", method: "POST", body: payload
        )
        return response.request
    }

    func cancel(requestID: String) async throws -> ChatRequest {
        let response: CancelResponse = try await request(
            "/api/runs/\(segment(requestID))/cancel", method: "POST", body: EmptyBody()
        )
        return response.request
    }

    func patch(botID: String, changes: BotPatch) async throws -> BotListResponse {
        try await request("/api/bots/\(segment(botID))", method: "PATCH", body: changes)
    }

    func createBot() async throws -> BotListResponse {
        let payload = CreateBotRequest(
            id: "bot-\(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""))",
            name: "New agent", description: "", provider: "codex", model: "gpt-6-astra",
            effort: "medium", mode: "auto",
            avatar: BotAvatar(shape: "hexagon", color: "#00ad9c", image: nil),
            computer: ComputerAccess(scope: "none", level: "read", network: "off", folder: nil)
        )
        return try await request("/api/bots", method: "POST", body: payload)
    }

    private func request<Response: Decodable>(_ path: String) async throws -> Response {
        var request = URLRequest(url: url(path))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 10
        return try await perform(request)
    }

    private func request<Response: Decodable, Body: Encodable>(
        _ path: String, method: String, body: Body
    ) async throws -> Response {
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONEncoder().encode(body)
        request.timeoutInterval = 20
        return try await perform(request)
    }

    private func perform<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, rawResponse) = try await URLSession.shared.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse else { throw BunjiAPIError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data).error) ?? "Bunji request failed (HTTP \(response.statusCode))."
            throw BunjiAPIError.server(message)
        }
        do { return try JSONDecoder().decode(Response.self, from: data) }
        catch { throw BunjiAPIError.invalidResponse }
    }

    private func url(_ path: String) -> URL { URL(string: path, relativeTo: baseURL)! }
    private func segment(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value }
}

private struct HealthResponse: Decodable { let service: String }
private struct ErrorResponse: Decodable { let error: String }
private struct EmptyBody: Encodable {}
