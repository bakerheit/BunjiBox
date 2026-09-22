import SwiftUI
import UniformTypeIdentifiers

struct AgentProfileEditor: View {
    let bot: Bot
    let save: (BotPatch) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var description: String
    @State private var avatar: BotAvatar
    @State private var importing = false
    @State private var saving = false
    @State private var error: String?

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
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction).disabled(saving)
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
                        Divider().padding(.vertical, 4)
                        HStack(spacing: 12) {
                            Button { avatar.image = "/teal-bot.png" } label: {
                                HStack {
                                    AvatarView(avatar: BotAvatar(shape: avatar.shape, color: avatar.color, image: "/teal-bot.png"), size: 30)
                                    Text("Use starter picture")
                                }
                            }
                            Button("Upload picture…", systemImage: "photo") { importing = true }
                        }
                        Text("PNG, JPG or WebP · up to 5 MB. Pictures are cropped to a square.")
                            .font(.caption).foregroundStyle(.secondary)
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
        .fileImporter(isPresented: $importing, allowedContentTypes: [.png, .jpeg, .webP]) { result in
            do { avatar.image = try AvatarImageData.load(result.get()); error = nil }
            catch { self.error = error.localizedDescription }
        }
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
            dismiss()
        } catch { self.error = error.localizedDescription }
        saving = false
    }
}
