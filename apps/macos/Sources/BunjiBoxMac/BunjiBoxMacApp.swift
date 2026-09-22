import SwiftUI

@main
struct BunjiBoxMacApp: App {
    @StateObject private var store = WorkspaceStore()

    var body: some Scene {
        WindowGroup("BunjiBox") {
            RootView(store: store)
                .frame(minWidth: 980, minHeight: 640)
                .preferredColorScheme(.dark)
                .task { await store.start() }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1240, height: 780)

        Settings {
            Form {
                Section("Bunji service") {
                    LabeledContent("Address", value: "127.0.0.1:4318")
                    Text("The native app shares the same local workspace as BunjiBox web and CLI.")
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .padding()
            .frame(width: 460, height: 220)
        }
    }
}
