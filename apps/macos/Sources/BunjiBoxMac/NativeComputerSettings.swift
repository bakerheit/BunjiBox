import SwiftUI

struct NativeComputerSettings: View {
    @ObservedObject var store: WorkspaceStore
    let bot: Bot
    @State private var pendingTarget: (botID: String, target: String)?
    @State private var machineConfirmation: Bot?
    @State private var savingAccess = false
    private var eligible: Bool {
        bot.computer.scope == "machine" && bot.computer.level == "auto" && ["codex", "claude"].contains(bot.provider)
    }

    var body: some View {
        if bot.computer.scope != "machine" || bot.computer.level != "auto" {
            Button(savingAccess ? "Saving access…" : "Enable This Mac full access…") {
                machineConfirmation = bot
            }
            .disabled(savingAccess || !["codex", "claude"].contains(bot.provider))
            .confirmationDialog("Allow full access to this Mac?", isPresented: Binding(
                get: { machineConfirmation != nil },
                set: { if !$0 { machineConfirmation = nil } }
            )) {
                Button("Allow full access", role: .destructive) {
                    guard let confirmedBot = machineConfirmation else { return }
                    machineConfirmation = nil
                    savingAccess = true
                    Task {
                        await store.confirmFullMachine(botID: confirmedBot.id, network: confirmedBot.computer.network)
                        savingAccess = false
                    }
                }
                Button("Cancel", role: .cancel) { machineConfirmation = nil }
            } message: {
                Text("\(machineConfirmation?.name ?? bot.name) can read and change files across this Mac and run commands without asking each time. This replaces any folder limit. Native control remains a separate opt-in below. Accessibility and Screen Recording still require OS permission.")
            }
        }
        Picker("Target", selection: Binding(get: { bot.nativeComputer ?? "off" }, set: { target in
            if target == "off" { saveTarget(botID: bot.id, target: "off") }
            else { pendingTarget = (bot.id, target) }
        })) {
            Text("Off").tag("off")
            Text("Apple Notes").tag("com.apple.Notes").disabled(!eligible)
            Text("Disposable fixture · testing").tag("fixture").disabled(!eligible)
        }
        Text(eligible
             ? "Ask this agent to use the native fixture or Notes in chat. A separate native window shows snapshot previews, Take over, Resume, and Stop."
             : "Choose Codex or Claude and enable This Mac full access above, then choose a native target.")
            .font(.caption).foregroundStyle(.secondary)
        Text("Notes needs Accessibility and Screen Recording grants for Bunji Native Lab. The helper reports actual permission status. This setting does not grant OS permissions. Supported targets: Apple Notes and the test fixture.")
            .font(.caption).foregroundStyle(.secondary)
        .confirmationDialog("Enable native control for this agent?", isPresented: Binding(get: { pendingTarget != nil }, set: { if !$0 { pendingTarget = nil } })) {
            Button("Enable native control") {
                if let target = pendingTarget {
                    saveTarget(botID: target.botID, target: target.target)
                }
                pendingTarget = nil
            }
            Button("Cancel", role: .cancel) { pendingTarget = nil }
        } message: {
            Text("The agent can read and change the selected target during Agent chat. Take over pauses control; Stop ends the helper session. Turn this setting off to disable future turns. Cancel a running chat to end its helper.")
        }
    }

    private func saveTarget(botID: String, target: String) {
        Task {
            do {
                try await store.saveProfile(botID: botID, changes: BotPatch(nativeComputer: target))
                store.errorMessage = nil
            } catch { store.errorMessage = error.localizedDescription }
        }
    }
}
