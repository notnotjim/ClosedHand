import SwiftUI
import EventKit
import Contacts

struct MenuBarView: View {
    @StateObject private var bridge = BridgeManager.shared
    @State private var showComputerControlAlert = false
    @State private var permissionRefresh = false // Toggled to force re-check permissions
    private let permissionTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Header
            HStack(spacing: 8) {
                if let logoUrl = Bundle.module.url(forResource: "logo", withExtension: "png"),
                   let logoData = try? Data(contentsOf: logoUrl),
                   let nsImage = NSImage(data: logoData) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .frame(width: 20, height: 20)
                        .opacity(0.9)
                }
                Text("ClosedHand Bridge")
                    .font(.headline)
                Spacer()
                if bridge.isActive {
                    Image(systemName: "eye.fill")
                        .foregroundColor(.orange)
                        .font(.caption)
                        .symbolEffect(.pulse)
                } else {
                    Circle()
                        .fill(bridge.isConnected ? .green : .red)
                        .frame(width: 8, height: 8)
                }
            }

            // Activity banner
            if bridge.isActive {
                HStack(spacing: 4) {
                    Circle()
                        .fill(.orange)
                        .frame(width: 6, height: 6)
                    Text("ClosedHand is using: \(bridge.lastAction)")
                        .font(.caption2)
                        .foregroundColor(.orange)
                }
            }

            Divider()

            // Pairing (when not paired)
            if !bridge.isPaired {
                if !bridge.pairingCode.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Enter this code on your dashboard:")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Text(bridge.pairingCode)
                            .font(.system(.title2, design: .monospaced))
                            .fontWeight(.bold)
                            .textSelection(.enabled)
                    }
                } else {
                    Button("Pair with ClosedHand...") {
                        bridge.startPairing()
                    }
                }
            }

            // Main content (when paired)
            if bridge.isPaired {
                // APPS section
                SectionLabel(text: "APPS")

                AppToggleRow(title: "Calendar", icon: "calendar", isOn: $bridge.shareCalendar)
                AppToggleRow(title: "Reminders", icon: "checklist", isOn: $bridge.shareReminders)
                AppToggleRow(title: "Contacts", icon: "person.2.fill", isOn: $bridge.shareContacts)
                AppToggleRow(title: "Notes", icon: "note.text", isOn: $bridge.shareNotes)

                // System permissions (Accessibility + Screen Recording)
                SystemToggleRow(title: "Screen Vision", icon: "eye.fill", granted: hasScreenRecording, settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                SystemToggleRow(title: "App Control", icon: "hand.tap.fill", granted: hasAccessibility, settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")

                Divider()

                // COMPUTER CONTROL section
                HStack {
                    Image(systemName: bridge.unrestrictedMode ? "lock.open.fill" : "lock.fill")
                        .foregroundColor(bridge.unrestrictedMode ? .orange : .gray)
                        .font(.system(size: 12))
                        .frame(width: 16)
                    Text("Computer Control")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .foregroundColor(bridge.unrestrictedMode ? .orange : .secondary)
                    Spacer()
                    Toggle("", isOn: Binding(
                        get: { bridge.unrestrictedMode },
                        set: { newValue in
                            if newValue {
                                showComputerControlAlert = true
                            } else {
                                bridge.unrestrictedMode = false
                                bridge.saveSettings()
                            }
                        }
                    ))
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .tint(.orange)
                    .labelsHidden()
                }

                if bridge.unrestrictedMode {
                    VStack(spacing: 2) {
                        AppToggleRow(title: "Files", icon: "folder.fill", isOn: $bridge.shareFiles, tint: .orange)
                        AppToggleRow(title: "Browser", icon: "safari.fill", isOn: $bridge.shareBrowser, tint: .orange)
                        AppToggleRow(title: "Terminal", icon: "terminal.fill", isOn: $bridge.shareShell, tint: .orange)
                    }
                    .padding(.leading, 20)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                } else {
                    Text("Files, browser, and terminal access.")
                        .font(.caption2)
                        .foregroundColor(.secondary.opacity(0.7))
                        .padding(.leading, 22)
                }

                Divider()

                // Utilities
                AppToggleRow(title: "Keep Mac Awake", icon: "bolt.fill", isOn: $bridge.keepAwake)
                AppToggleRow(title: "Launch at Login", icon: "sunrise.fill", isOn: $bridge.launchAtLogin)

                // Fix permissions link
                Button(action: {
                    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation") {
                        NSWorkspace.shared.open(url)
                    }
                }) {
                    HStack(spacing: 6) {
                        Image(systemName: "gearshape.fill")
                            .font(.system(size: 10))
                        Text("Fix App Permissions")
                            .font(.caption)
                    }
                    .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
            }

            Divider()

            // Footer
            HStack {
                if bridge.isPaired {
                    Button("Disconnect") {
                        bridge.unpair()
                    }
                    .foregroundColor(.red)
                    .font(.caption)
                }
                Spacer()
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .font(.caption)
                .foregroundColor(.secondary)
            }
        }
        .padding(12)
        .frame(width: 260)
        .animation(.easeOut(duration: 0.2), value: bridge.unrestrictedMode)
        .onReceive(permissionTimer) { _ in
            // Poll permission state so toggles update after user grants in System Settings
            let _ = permissionRefresh // Force SwiftUI to re-evaluate computed properties
            permissionRefresh.toggle()
        }
        .alert("Enable Computer Control?", isPresented: $showComputerControlAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Enable") {
                bridge.unrestrictedMode = true
                bridge.saveSettings()
            }
        } message: {
            Text("ClosedHand will be able to access your files, control your browser, and run terminal commands. You can turn this off at any time.")
        }
    }

    // MARK: - Permission checks

    private var hasAccessibility: Bool {
        let _ = permissionRefresh // Re-evaluate when permissionRefresh changes
        return AXIsProcessTrusted()
    }

    private var hasScreenRecording: Bool {
        let _ = permissionRefresh
        return CGWindowListCreateImage(CGRect(x: 0, y: 0, width: 1, height: 1), .optionOnScreenOnly, kCGNullWindowID, []) != nil
    }

    // Calendar, Reminders, Contacts use AppleScript, not EventKit/Contacts frameworks
    // so they don't need system-level privacy permissions from this app.
}

// MARK: - Supporting types

enum PermissionState {
    case granted
    case canRequest
    case needsSystemSetting
}

struct SystemToggleRow: View {
    let title: String
    let icon: String
    let granted: Bool
    var settingsURL: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .frame(width: 16)
                .foregroundColor(granted ? .green : .gray)
            Text(title)
                .font(.subheadline)
                .foregroundColor(granted ? .primary : .secondary)
            Spacer()
            // Visual-only toggle that shows permission state
            Toggle("", isOn: .constant(granted))
                .toggleStyle(.switch)
                .controlSize(.small)
                .tint(.green)
                .labelsHidden()
                .allowsHitTesting(false) // Never interactive, taps go to row
                .opacity(granted ? 1.0 : 0.5)
        }
        .frame(height: 24)
        .contentShape(Rectangle())
        .onTapGesture {
            if !granted {
                if let url = URL(string: settingsURL) {
                    NSWorkspace.shared.open(url)
                }
            }
        }
        .help(granted ? "\(title) is enabled" : "Requires macOS permission. Click to open Settings.")
    }
}

struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(.secondary)
            .padding(.top, 2)
    }
}

struct AppToggleRow: View {
    let title: String
    let icon: String
    @Binding var isOn: Bool
    var permissionStatus: PermissionState = .granted
    var tint: Color = .green
    var systemSettingsURL: String? = nil

    private var needsFix: Bool {
        isOn && permissionStatus != .granted
    }

    var body: some View {
        if needsFix {
            // When permission needs fixing, the whole row is a button
            Button(action: handlePermissionFix) {
                HStack(spacing: 6) {
                    Image(systemName: icon)
                        .font(.system(size: 12))
                        .frame(width: 16)
                        .foregroundColor(.orange)
                    Text(title)
                        .font(.subheadline)
                        .foregroundColor(.primary)
                    Spacer()
                    HStack(spacing: 3) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                        Text("Fix")
                            .font(.caption2)
                    }
                    .foregroundColor(.orange)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.orange.opacity(0.15))
                    .cornerRadius(4)
                }
                .frame(height: 24)
            }
            .buttonStyle(.plain)
            .help("Opens System Settings. If ClosedHand Bridge isn't listed, restart your Mac and try again.")
        } else {
            // Normal toggle row
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 12))
                    .frame(width: 16)
                    .foregroundColor(isOn ? tint : .gray)
                Text(title)
                    .font(.subheadline)
                Spacer()
                Toggle("", isOn: Binding(
                    get: { isOn },
                    set: { newValue in
                        if newValue && permissionStatus != .granted {
                            handlePermissionFix()
                        }
                        isOn = newValue
                    }
                ))
                .toggleStyle(.switch)
                .controlSize(.small)
                .tint(tint)
                .labelsHidden()
            }
            .frame(height: 24)
        }
    }

    private func handlePermissionFix() {
        let settingsURLs: [String: String] = [
            "Calendar": "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars",
            "Reminders": "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders",
            "Contacts": "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts",
            "Screen Vision": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            "App Control": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        ]

        // Try requesting permission directly (shows popup if not yet determined)
        Task {
            var granted = false
            switch title {
            case "Calendar":
                granted = (try? await EKEventStore().requestFullAccessToEvents()) ?? false
            case "Reminders":
                granted = (try? await EKEventStore().requestFullAccessToReminders()) ?? false
            case "Contacts":
                granted = (try? await CNContactStore().requestAccess(for: .contacts)) ?? false
            default:
                break
            }

            // If not granted (denied or no popup appeared), open System Settings
            if !granted {
                let url = systemSettingsURL ?? settingsURLs[title]
                if let url = url {
                    let process = Process()
                    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                    process.arguments = [url]
                    try? process.run()
                }
            }
        }
    }
}
