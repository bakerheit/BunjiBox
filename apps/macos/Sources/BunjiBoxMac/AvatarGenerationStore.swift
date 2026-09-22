import Foundation
import Combine

/// Owns generation only. Applying a preview to the profile draft is always a separate user action.
@MainActor
final class AvatarGenerationStore: ObservableObject {
    enum Phase: Equatable { case idle, running, ready, failed, cancelling, cancelled, cancelFailed }

    @Published var prompt = ""
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var preview: String?
    @Published private(set) var error: String?

    private let api: BunjiAPI
    private let pollInterval: Duration
    private var pending: AvatarGenerationRequest?
    private var accepted = false
    private var task: Task<Void, Never>?
    private var revision = UUID()
    private var dismissed = false

    init(api: BunjiAPI = BunjiAPI(), pollInterval: Duration = .seconds(1)) {
        self.api = api
        self.pollInterval = pollInterval
    }

    var hasPendingRequest: Bool { pending != nil }
    var isBusy: Bool { phase == .running || phase == .cancelling }
    var canGenerate: Bool {
        !dismissed && !isBusy && phase != .cancelFailed &&
        (pending != nil || (!prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && prompt.utf16.count <= 2000))
    }

    func generate() {
        guard canGenerate else { return }
        // Retain both ID and original prompt if creation may have reached the server.
        let request = pending ?? AvatarGenerationRequest(
            id: "run-\(UUID().uuidString.lowercased())",
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        )
        pending = request
        phase = .running
        error = nil
        preview = nil
        revision = UUID()
        let current = revision
        task = Task { await run(request, revision: current) }
    }

    private func run(_ request: AvatarGenerationRequest, revision current: UUID) async {
        do {
            var result = try await accepted
                ? api.avatarGeneration(id: request.id)
                : api.createAvatarGeneration(request)
            guard isCurrent(current) else { return }
            accepted = true
            while true {
                guard result.id == request.id else { throw BunjiAPIError.invalidResponse }
                switch result.status {
                case .running:
                    try await Task.sleep(for: pollInterval)
                    guard isCurrent(current) else { return }
                    result = try await api.avatarGeneration(id: request.id)
                    guard isCurrent(current) else { return }
                case .complete:
                    pending = nil
                    accepted = false
                    guard let image = result.image else { throw AvatarImageError.unreadable }
                    // Decode the raw data URL and resize off the UI thread before offering it for use.
                    let normalized = try await Task.detached {
                        try AvatarImageData.normalizeGenerated(image)
                    }.value
                    guard isCurrent(current) else { return }
                    preview = normalized
                    phase = .ready
                    return
                case .failed:
                    pending = nil
                    accepted = false
                    error = result.error ?? "Picture generation failed. Try again."
                    phase = .failed
                    return
                case .cancelled:
                    pending = nil
                    accepted = false
                    phase = .cancelled
                    return
                }
            }
        } catch {
            guard isCurrent(current) else { return }
            var message = error.localizedDescription
            if let apiError = error as? BunjiAPIError {
                switch apiError {
                case .http(404, _) where accepted:
                    // The service restarted or evicted this job. A retry must create a new one.
                    pending = nil
                    accepted = false
                    message = "This generation has expired or is no longer available. Generate a new picture."
                case .http(400, _) where !accepted:
                    // A definite creation rejection lets the user edit the prompt before retrying.
                    pending = nil
                    accepted = false
                default: break // Ambiguous failures retain the original ID and prompt.
                }
            }
            self.error = message
            phase = .failed
        }
    }

    func cancel() {
        guard phase != .cancelling else { return }
        revision = UUID() // Ignore late create, poll, and image-normalization results immediately.
        preview = nil
        error = nil
        guard let request = pending else {
            phase = .cancelled
            return
        }
        phase = .cancelling
        let previous = task
        let current = revision
        task = Task {
            // Let a short creation request settle before sending cancel, including an ambiguous POST.
            // Invalidating the revision makes its response harmless without racing a second request.
            await previous?.value
            do {
                let result = try await api.cancelAvatarGeneration(id: request.id)
                guard result.id == request.id, result.status != .running else {
                    throw BunjiAPIError.invalidResponse
                }
                guard revision == current else { return }
                pending = nil
                accepted = false
                phase = .cancelled
            } catch {
                guard revision == current else { return }
                if let apiError = error as? BunjiAPIError, case .http(404, _) = apiError {
                    // Missing jobs have no remaining work to cancel.
                    pending = nil
                    accepted = false
                    phase = .cancelled
                    return
                }
                self.error = "Could not confirm cancellation. \(error.localizedDescription)"
                phase = .cancelFailed
            }
        }
    }

    func dismiss() {
        guard !dismissed else { return }
        dismissed = true
        cancel()
    }

    private func isCurrent(_ current: UUID) -> Bool { !dismissed && revision == current }
}
