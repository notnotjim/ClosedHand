import SwiftUI

struct SettingsView: View {
    @StateObject private var bridge = BridgeManager.shared
    @State private var deleteConfirmText = ""
    @State private var isDeleting = false
    @State private var deleteMessage = ""

    private var deleteProgress: Double {
        let target = "DELETE"
        guard !deleteConfirmText.isEmpty else { return 0 }
        let matching = zip(deleteConfirmText.uppercased(), target).filter { $0 == $1 }.count
        return Double(matching) / Double(target.count)
    }

    private var canDelete: Bool {
        deleteConfirmText.uppercased() == "DELETE"
    }

    var body: some View {
        Form {
            Section("Connection") {
                LabeledContent("Status") {
                    HStack {
                        Circle()
                            .fill(bridge.isConnected ? .green : .red)
                            .frame(width: 8, height: 8)
                        Text(bridge.isConnected ? "Connected" : "Disconnected")
                    }
                }

                LabeledContent("Server") {
                    TextField("Server URL", text: $bridge.serverUrl)
                        .textFieldStyle(.roundedBorder)
                }

                if bridge.isPaired {
                    Button("Unpair") {
                        bridge.unpair()
                    }
                    .foregroundColor(.red)
                }
            }

            Section("Launch") {
                Toggle("Start at login", isOn: $bridge.launchAtLogin)
            }

            Section("Your Data") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Disconnect and remove Bridge data")
                        .font(.subheadline)
                        .fontWeight(.medium)
                    Text("Unpairs this Mac, removes your Bridge connection from ClosedHand's servers, and clears any cached Bridge data. Your conversations, memory, and other ClosedHand data are not affected.")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    HStack(spacing: 8) {
                        ZStack(alignment: .leading) {
                            GeometryReader { geo in
                                Rectangle()
                                    .fill(canDelete ? Color.red.opacity(0.2) : Color.orange.opacity(0.15))
                                    .frame(width: geo.size.width * deleteProgress)
                                    .animation(.easeOut(duration: 0.15), value: deleteProgress)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 6))

                            TextField("Type DELETE", text: $deleteConfirmText)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(.body, design: .monospaced))
                        }
                        .frame(height: 28)

                        Button(action: { wipeData() }) {
                            Text(isDeleting ? "Removing..." : "Remove")
                        }
                        .disabled(!canDelete || isDeleting)
                        .foregroundColor(canDelete ? .red : .gray)
                    }

                    if !deleteMessage.isEmpty {
                        Text(deleteMessage)
                            .font(.caption)
                            .foregroundColor(deleteMessage.contains("Error") ? .red : .green)
                    }

                    Text("To wipe all ClosedHand data (conversations, memory, etc.), use the dashboard Settings tab.")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.7))
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 420, height: 400)
        .navigationTitle("ClosedHand Bridge Settings")
    }

    private func wipeData() {
        guard canDelete else { return }
        isDeleting = true
        deleteMessage = ""

        Task {
            do {
                let baseUrl = bridge.serverUrl
                    .replacingOccurrences(of: "wss://", with: "https://")
                    .replacingOccurrences(of: "ws://", with: "http://")
                    .replacingOccurrences(of: "/bridge", with: "")

                guard let url = URL(string: baseUrl + "/api/bridge/disconnect") else {
                    await MainActor.run { deleteMessage = "Error: invalid server URL"; isDeleting = false }
                    return
                }

                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.addValue("application/json", forHTTPHeaderField: "Content-Type")

                if let token = UserDefaults.standard.string(forKey: "bridgeToken") {
                    request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }

                let (_, response) = try await URLSession.shared.data(for: request)
                let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

                await MainActor.run {
                    if statusCode >= 200 && statusCode < 300 {
                        bridge.unpair()
                        deleteMessage = "Bridge disconnected and data removed."
                        deleteConfirmText = ""
                    } else {
                        deleteMessage = "Error: server returned \(statusCode). Try from the dashboard instead."
                    }
                    isDeleting = false
                }
            } catch {
                await MainActor.run {
                    deleteMessage = "Error: \(error.localizedDescription)"
                    isDeleting = false
                }
            }
        }
    }
}
