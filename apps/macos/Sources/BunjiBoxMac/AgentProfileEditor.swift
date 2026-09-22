import SwiftUI
import UniformTypeIdentifiers

struct AgentProfileEditor: View {
    private enum PictureTab: String, CaseIterable { case avatar = "Avatar", generate = "Generate", upload = "Upload" }
    let bot: Bot
    let save: (BotPatch) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var description: String
    @State private var avatar: BotAvatar
    @State private var importing = false
    @State private var saving = false
    @State private var error: String?
    @State private var pictureTab: PictureTab = .avatar
    @State private var isPresented = true
    @StateObject private var generation = AvatarGenerationStore()

    init(bot: Bot, save: @escaping (BotPatch) async throws -> Void) {
        self.bot = bot
        self.save = save
        _name = State(initialValue: bot.name)
        _description = State(initialValue: bot.description)
        _avatar = State(initialValue: bot.avatar)
    }

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var valid: Bool { !trimmedName.isEmpty && name.utf16.count <= 60 && description.utf16.count <= 1800 }
    private var changed: Bool { trimmedName != bot.name || description != bot.description || avatar != bot.avatar }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Edit profile").font(.title2.bold())
                Spacer()
                Button("Cancel") { closeEditor() }.keyboardShortcut(.cancelAction).disabled(saving)
            }.padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        Spacer()
                        AvatarView(avatar: avatar, size: 96)
                        Spacer()
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Name").font(.headline)
                        TextField("Agent name", text: $name).textFieldStyle(.roundedBorder)
                            .accessibilityLabel("Agent name")
                        Text("\(name.utf16.count)/60").font(.caption).foregroundStyle(name.utf16.count > 60 ? .red : .secondary)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Description").font(.headline)
                        TextField("What this agent is for", text: $description, axis: .vertical)
                            .lineLimit(2...4).textFieldStyle(.roundedBorder).accessibilityLabel("Agent description")
                        if description.utf16.count > 1800 { Text("Keep the description under 1,800 characters.").font(.caption).foregroundStyle(.red) }
                    }
                    VStack(alignment: .leading, spacing: 10) {
                        Picker("Picture source", selection: $pictureTab) {
                            ForEach(PictureTab.allCases, id: \.self) { tab in
                                Text(tab.rawValue).tag(tab)
                            }
                        }.pickerStyle(.segmented)
                        switch pictureTab {
                        case .avatar: avatarControls
                        case .generate: generationControls
                        case .upload:
                            Button("Upload picture…", systemImage: "photo") { importing = true }
                            Text("PNG, JPG or WebP · up to 5 MB. Pictures are cropped to a square.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }.padding(20).disabled(saving)
            }
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                if let error { Text(error).foregroundStyle(.red).font(.callout).accessibilityLabel("Save error: \(error)") }
                HStack {
                    Text("Shared across your devices").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if saving { ProgressView().controlSize(.small) }
                    Button(saving ? "Saving…" : "Save changes") { Task { await saveChanges() } }
                        .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                        .disabled(saving || !valid || !changed)
                }
            }.padding(20)
        }
        .frame(width: 460, height: 700)
        .interactiveDismissDisabled(saving)
        .onChange(of: pictureTab) { previous, current in
            if previous == .generate && current != .generate { generation.cancel() }
        }
        .onDisappear { isPresented = false; generation.dismiss() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.png, .jpeg, .webP]) { result in
            guard isPresented, pictureTab == .upload, !saving else { return }
            do { avatar.image = try AvatarImageData.load(result.get()); error = nil }
            catch { self.error = error.localizedDescription }
        }
    }

    private var avatarControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Avatar").font(.headline)
                Spacer()
                Button("Reset") { avatar = AvatarPalette.defaultAvatar }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 5), spacing: 10) {
                ForEach(AvatarPalette.shapes, id: \.self) { shape in
                    Button { avatar.shape = shape; avatar.image = nil } label: {
                        AvatarView(avatar: BotAvatar(shape: shape, color: avatar.color, image: nil), size: 44)
                            .padding(6).background(selection(avatar.image == nil && avatar.shape == shape))
                    }
                    .buttonStyle(.plain).accessibilityLabel("\(shape.capitalized) shape")
                    .accessibilityAddTraits(avatar.image == nil && avatar.shape == shape ? [.isSelected] : [])
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 10) {
                ForEach(AvatarPalette.colors, id: \.value) { color in
                    Button { avatar.color = color.value; avatar.image = nil } label: {
                        Circle().fill(Color(hex: color.value)).frame(width: 28, height: 28)
                            .padding(6).background(selection(avatar.image == nil && avatar.color.lowercased() == color.value))
                    }
                    .buttonStyle(.plain).accessibilityLabel("\(color.name) color")
                    .accessibilityAddTraits(avatar.image == nil && avatar.color.lowercased() == color.value ? [.isSelected] : [])
                }
            }
        }
    }

    private var generationControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Create a picture with your signed-in ChatGPT account through Codex.")
                .font(.caption).foregroundStyle(.secondary)
            TextField("Describe your agent’s picture", text: $generation.prompt, axis: .vertical)
                .lineLimit(3...6).textFieldStyle(.roundedBorder)
                .accessibilityLabel("Picture prompt")
                .disabled(generation.hasPendingRequest || generation.isBusy)
            Text("\(generation.prompt.utf16.count)/2,000")
                .font(.caption).foregroundStyle(generation.prompt.utf16.count > 2000 ? .red : .secondary)
            if generation.isBusy {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(generation.phase == .cancelling ? "Cancelling…" : "Generating your picture…")
                        .font(.callout)
                }
                if generation.phase == .running {
                    Text("This can take a few minutes. Leaving Generate cancels generation and keeps your prompt.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let message = generation.error {
                Text(message).foregroundStyle(.red).font(.callout)
                    .accessibilityLabel("Generation error: \(message)")
                if generation.hasPendingRequest && generation.phase == .failed {
                    Text("Retry reconnects to the same generation. Your prompt has been kept.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if generation.phase == .cancelled {
                Text("Generation cancelled. Your profile picture is unchanged.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                if generation.phase == .cancelFailed {
                    Button("Retry cancellation") { generation.cancel() }
                } else if !generation.isBusy {
                    Button(generation.phase == .failed ? "Retry" : generation.phase == .ready ? "Generate another" : "Generate") {
                        generation.generate()
                    }.disabled(!generation.canGenerate)
                }
                if generation.hasPendingRequest && generation.phase != .cancelling && generation.phase != .cancelFailed {
                    Button("Cancel generation", role: .cancel) { generation.cancel() }
                }
            }
            if let preview = generation.preview {
                HStack(spacing: 16) {
                    AvatarView(avatar: BotAvatar(shape: avatar.shape, color: avatar.color, image: preview), size: 96)
                        .accessibilityLabel("Generated picture preview")
                    VStack(alignment: .leading, spacing: 8) {
                        Button("Use this picture") {
                            guard isPresented, pictureTab == .generate, !saving else { return }
                            avatar.image = preview
                        }.disabled(avatar.image == preview)
                        Text(avatar.image == preview ? "Added to your draft. Save changes to keep it." : "Preview only. Use this picture to add it to your draft.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func closeEditor() {
        isPresented = false
        generation.dismiss()
        dismiss()
    }

    private func selection(_ selected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 10)
            .fill(selected ? Color.accentColor.opacity(0.18) : Color.clear)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? Color.accentColor : .clear, lineWidth: 2))
    }

    private func saveChanges() async {
        guard valid, changed, !saving else { return }
        saving = true
        error = nil
        do {
            // Submit only edited fields; a picture change must not overwrite a newer name.
            try await save(BotPatch(name: trimmedName == bot.name ? nil : trimmedName,
                                    description: description == bot.description ? nil : description,
                                    avatar: avatar == bot.avatar ? nil : avatar))
            closeEditor()
        } catch { self.error = error.localizedDescription }
        saving = false
    }
}
