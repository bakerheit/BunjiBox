import SwiftUI

struct RootView: View {
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        NavigationSplitView {
            AgentSidebar(store: store)
                .navigationSplitViewColumnWidth(min: 210, ideal: 240, max: 300)
        } content: {
            ChatWorkspace(store: store)
                .navigationSplitViewColumnWidth(min: 500, ideal: 690)
        } detail: {
            InspectorView(store: store)
                .navigationSplitViewColumnWidth(min: 270, ideal: 320, max: 400)
        }
        .overlay {
            if store.isConnecting {
                ProgressView("Connecting to Bunji…")
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .alert("BunjiBox", isPresented: Binding(
            get: { store.errorMessage != nil },
            set: { if !$0 { store.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { store.errorMessage = nil }
        } message: {
            Text(store.errorMessage ?? "Unknown error")
        }
    }
}

private struct AgentSidebar: View {
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("BunjiBox", systemImage: "shippingbox.fill").font(.headline)
                Spacer()
                Button { Task { await store.createBot() } } label: { Image(systemName: "plus") }
                    .buttonStyle(.plain).help("New agent")
            }
            .padding(14)

            List {
                Section("Agents") {
                    ForEach(store.bots) { bot in
                        Button { store.select(bot) } label: {
                            HStack(spacing: 10) {
                                AvatarView(avatar: bot.avatar, size: 32)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(bot.name).lineLimit(1)
                                    Text(bot.description.isEmpty ? RuntimeCatalog.labels[bot.provider] ?? bot.provider : bot.description)
                                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .padding(.vertical, 3)
                        .listRowBackground(store.selectedBotID == bot.id ? Color.accentColor.opacity(0.18) : Color.clear)
                    }
                }
            }
            .listStyle(.sidebar)

            HStack(spacing: 8) {
                Circle().fill(.green).frame(width: 7, height: 7)
                Text("Local workspace").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(14)
        }
    }
}

private struct ChatWorkspace: View {
    @ObservedObject var store: WorkspaceStore

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                if let bot = store.selectedBot {
                    AvatarView(avatar: bot.avatar, size: 30)
                    Text(bot.name).font(.headline)
                    Text(RuntimeCatalog.labels[bot.provider] ?? bot.provider)
                        .font(.caption).foregroundStyle(.secondary)
                } else { Text("No agent selected").foregroundStyle(.secondary) }
                Spacer()
                Button { Task { await store.refreshHistory() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).help("Refresh")
            }
            .padding(.horizontal, 16).frame(height: 52)
            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 18) {
                        if store.requests.isEmpty, let bot = store.selectedBot {
                            ContentUnavailableView(
                                "What can I take off your plate?",
                                systemImage: "sparkles",
                                description: Text(bot.description.isEmpty ? "Start a continuous chat with \(bot.name)." : bot.description)
                            )
                            .padding(.top, 90)
                        }
                        ForEach(store.requests) { request in
                            ChatTurn(request: request).id(request.id)
                        }
                    }
                    .padding(24)
                }
                .onChange(of: store.requests.count) { _, _ in
                    if let id = store.requests.last?.id { withAnimation { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }

            Divider()
            ComposerView(store: store)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.25))
    }
}

private struct ChatTurn: View {
    let request: ChatRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Spacer(minLength: 70)
                Text(request.prompt)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
            }

            if !request.activities.isEmpty {
                DisclosureGroup("Activity · \(request.activities.count)") {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(request.activities) { activity in ActivityRow(activity: activity) }
                    }
                    .padding(.top, 8)
                }
                .font(.caption).foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("\(RuntimeCatalog.modelLabel(provider: request.provider, model: request.model)) · \(request.effort)")
                    .font(.caption).foregroundStyle(.secondary)
                if request.isRunning {
                    HStack { ProgressView().controlSize(.small); Text("Working…") }.foregroundStyle(.secondary)
                } else if !request.text.isEmpty {
                    MarkdownText(request.text)
                }
                if let error = request.error { Text(error).foregroundStyle(.red) }
                if let usage = request.usage {
                    Text("\(usage.outputTokens.formattedToken) output · \(usage.totalTokens.formattedToken) total")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .textSelection(.enabled)
        }
    }
}

private struct ActivityRow: View {
    let activity: RunActivity
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: activity.kind == "tool" ? "wrench.and.screwdriver" : activity.kind == "reasoning" ? "brain" : "bolt")
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(activity.title).foregroundStyle(.primary)
                if let text = activity.text, !text.isEmpty { Text(text).lineLimit(4) }
                if let output = activity.output, !output.isEmpty { Text(output).lineLimit(3).font(.caption2).monospaced() }
            }
            Spacer()
            Image(systemName: activity.status == "complete" ? "checkmark.circle.fill" : activity.status == "failed" ? "xmark.circle.fill" : "circle.dotted")
                .foregroundStyle(activity.status == "failed" ? .red : .secondary)
        }
    }
}

private struct MarkdownText: View {
    let value: String
    init(_ value: String) { self.value = value }
    var body: some View {
        if let attributed = try? AttributedString(markdown: value, options: .init(interpretedSyntax: .full)) {
            Text(attributed).lineSpacing(4)
        } else { Text(value).lineSpacing(4) }
    }
}

private struct ComposerView: View {
    @ObservedObject var store: WorkspaceStore
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 10) {
            ZStack(alignment: .topLeading) {
                if store.draft.isEmpty {
                    Text("Message \(store.selectedBot?.name ?? "agent")")
                        .foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 5)
                }
                TextEditor(text: $store.draft)
                    .font(.body).scrollContentBackground(.hidden).focused($focused)
                    .frame(minHeight: 56, maxHeight: 130)
                    .onKeyPress(.return, phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        Task { await store.send() }
                        return .handled
                    }
            }

            HStack(spacing: 10) {
                if let bot = store.selectedBot {
                    Menu(RuntimeCatalog.modelLabel(provider: bot.provider, model: bot.model)) {
                        ForEach(RuntimeCatalog.models[bot.provider] ?? [], id: \.id) { item in
                            Button(item.label) { store.setModel(item.id) }
                        }
                    }
                    .menuStyle(.borderlessButton)

                    EffortControl(bot: bot, setEffort: { store.setEffort($0) })
                }
                Spacer()
                if store.runningRequest != nil {
                    Button("Stop", role: .destructive) { Task { await store.cancel() } }
                } else {
                    Button { Task { await store.send() } } label: { Image(systemName: "arrow.up") }
                        .buttonStyle(.borderedProminent).buttonBorderShape(.circle)
                        .disabled(store.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isSending)
                }
            }
        }
        .padding(12)
        .background(.regularMaterial)
    }
}

private struct EffortControl: View {
    let bot: Bot
    let setEffort: (String) -> Void
    var efforts: [String] { RuntimeCatalog.efforts(for: bot.provider, model: bot.model) }
    var index: Double { Double(efforts.firstIndex(of: bot.effort) ?? 0) }

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "bolt.fill").foregroundStyle(.secondary)
            Slider(value: Binding(
                get: { index },
                set: { setEffort(efforts[min(max(Int($0.rounded()), 0), efforts.count - 1)]) }
            ), in: 0...Double(max(0, efforts.count - 1)), step: 1)
            .frame(width: 86)
            Text(bot.effort.capitalized).font(.caption).frame(width: 42, alignment: .leading)
        }
    }
}

private struct InspectorView: View {
    @ObservedObject var store: WorkspaceStore
    var body: some View {
        VStack(spacing: 0) {
            Picker("Inspector", selection: $store.inspectorTab) {
                ForEach(InspectorTab.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().padding(12)
            Divider()
            switch store.inspectorTab {
            case .activity: ActivityInspector(requests: store.requests)
            case .usage: UsageInspector(requests: store.requests)
            case .settings: AgentSettingsInspector(store: store)
            }
        }
    }
}

private struct ActivityInspector: View {
    let requests: [ChatRequest]
    var activities: [RunActivity] { Array(requests.flatMap(\.activities).reversed()) }
    var body: some View {
        List {
            if activities.isEmpty { ContentUnavailableView("No activity yet", systemImage: "bolt") }
            ForEach(activities) { ActivityRow(activity: $0).padding(.vertical, 4) }
        }
        .listStyle(.inset)
    }
}

private struct UsageInspector: View {
    let requests: [ChatRequest]
    private var input: Int { requests.compactMap { $0.usage?.inputTokens }.reduce(0, +) }
    private var output: Int { requests.compactMap { $0.usage?.outputTokens }.reduce(0, +) }
    private var cache: Int { requests.compactMap { $0.usage?.cachedInputTokens }.reduce(0, +) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Conversation usage").font(.headline)
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text((input + output).formatted()).font(.system(size: 34, weight: .light, design: .rounded))
                    Text("tokens").foregroundStyle(.secondary)
                }
                Divider()
                LabeledContent("Input", value: input.formatted())
                LabeledContent("Output", value: output.formatted())
                LabeledContent("Cache read", value: cache.formatted())
                Text("Cached tokens are included in provider input. Counts are cumulative for loaded messages.")
                    .font(.caption).foregroundStyle(.secondary)
                if let latest = requests.last?.usageBreakdown {
                    Divider()
                    Text("Latest input attribution").font(.headline)
                    LabeledContent("Typed message", value: latest.userMessage?.estimatedTokens.approxTokens ?? "Unavailable")
                    LabeledContent("Bunji context", value: latest.bunjiContext?.estimatedTokens.approxTokens ?? "Unavailable")
                    LabeledContent("Provider harness / unknown", value: latest.providerHarnessUnknown?.estimatedTokens.approxTokens ?? "Unavailable")
                }
            }
            .padding(16)
        }
    }
}

private struct AgentSettingsInspector: View {
    @ObservedObject var store: WorkspaceStore
    var body: some View {
        Form {
            if let bot = store.selectedBot {
                Section("Agent") {
                    LabeledContent("Name", value: bot.name)
                    LabeledContent("Provider", value: RuntimeCatalog.labels[bot.provider] ?? bot.provider)
                    LabeledContent("Model", value: RuntimeCatalog.modelLabel(provider: bot.provider, model: bot.model))
                }
                Section("Computer") {
                    LabeledContent("Access", value: bot.computer.scope == "machine" ? "This Mac · full access" : bot.computer.scope == "folder" ? "Selected folder" : "Not connected")
                    LabeledContent("Network", value: bot.computer.network.capitalized)
                }
                Section {
                    Text("Computer permissions are shared with web and CLI. Change high-risk access in BunjiBox Settings for now.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }
}

struct AvatarView: View {
    let avatar: BotAvatar
    let size: CGFloat
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: avatar.shape == "square" ? size * 0.23 : size * 0.42)
                .fill(Color(hex: avatar.color))
            HStack(spacing: size * 0.12) {
                Capsule().fill(.black.opacity(0.72)).frame(width: size * 0.1, height: size * 0.24).rotationEffect(.degrees(-10))
                Capsule().fill(.black.opacity(0.72)).frame(width: size * 0.1, height: size * 0.24).rotationEffect(.degrees(-10))
            }
        }
        .frame(width: size, height: size)
        .clipShape(avatar.shape == "circle" ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: avatar.shape == "square" ? size * 0.23 : size * 0.42)))
    }
}

private extension Optional where Wrapped == Int {
    var formattedToken: String { self?.formatted() ?? "Unavailable" }
    var approxTokens: String { self.map { "~\($0.formatted())" } ?? "Unavailable" }
}

private extension Color {
    init(hex: String) {
        let clean = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        let value = UInt64(clean, radix: 16) ?? 0x777777
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xff) / 255,
            green: Double((value >> 8) & 0xff) / 255,
            blue: Double(value & 0xff) / 255,
            opacity: 1
        )
    }
}
