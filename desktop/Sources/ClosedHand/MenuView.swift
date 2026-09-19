import SwiftUI
import AppKit

/// The menu: the stack's health at the top, then the Mac access controls
/// Bridge has always had (its rows and toggles, reused as they are), then
/// the ways in and out.
struct MenuView: View {
    @ObservedObject private var stack = Supervisor.shared
    @ObservedObject private var bridge = BridgeManager.shared
    @Environment(\.openWindow) private var openWindow
    @State private var showComputerControlAlert = false
    @State private var permissionRefresh = false
    private let permissionTimer = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let url = Bundle.module.url(forResource: "logo", withExtension: "png"), let img = NSImage(contentsOf: url) {
                    Image(nsImage: img).resizable().frame(width: 20, height: 20).opacity(0.9)
                }
                Text("ClosedHand").font(.headline)
                Spacer()
                if bridge.isActive {
                    Image(systemName: "eye.fill").foregroundColor(.orange).font(.caption).symbolEffect(.pulse)
                } else {
                    Circle().fill(overall).frame(width: 8, height: 8)
                }
            }

            if bridge.isActive {
                HStack(spacing: 4) {
                    Circle().fill(.orange).frame(width: 6, height: 6)
                    Text("ClosedHand is using: \(bridge.lastAction)").font(.caption2).foregroundColor(.orange)
                }
            }

            Divider()

            SectionLabel(text: "RUNNING HERE")
            VStack(alignment: .leading, spacing: 5) {
                row("Database", stack.database)
                row("ClosedHand", stack.bot)
                row("Dashboard", stack.web)
                row("Workspace", stack.agent)
                row("This Mac", bridge.isConnected ? .running : (stack.web == .running ? .starting : .stopped))
            }

            Button(action: { stack.openDashboard() }) {
                HStack(spacing: 6) {
                    Image(systemName: "safari").font(.system(size: 11))
                    Text("Open ClosedHand").font(.subheadline)
                    Spacer()
                    if !stack.address.isEmpty { Text(stack.address).font(.caption2.monospaced()).foregroundColor(.secondary) }
                }
            }
            .buttonStyle(.plain)
            .disabled(stack.web != .running)
            .padding(.top, 2)

            Divider()

            SectionLabel(text: "APPS")
            AppToggleRow(title: "Calendar", icon: "calendar", isOn: $bridge.shareCalendar)
            AppToggleRow(title: "Reminders", icon: "checklist", isOn: $bridge.shareReminders)
            AppToggleRow(title: "Contacts", icon: "person.2.fill", isOn: $bridge.shareContacts)
            AppToggleRow(title: "Notes", icon: "note.text", isOn: $bridge.shareNotes)
            SystemToggleRow(title: "Screen Vision", icon: "eye.fill", granted: hasScreenRecording, settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            SystemToggleRow(title: "App Control", icon: "hand.tap.fill", granted: hasAccessibility, settingsURL: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")

            Divider()

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
                    set: { on in
                        if on { showComputerControlAlert = true } else { bridge.unrestrictedMode = false; bridge.saveSettings() }
                    }
                ))
                .toggleStyle(.switch).controlSize(.small).tint(.orange).labelsHidden()
            }
            if bridge.unrestrictedMode {
                VStack(spacing: 2) {
                    AppToggleRow(title: "Files", icon: "folder.fill", isOn: $bridge.shareFiles, tint: .orange)
                    AppToggleRow(title: "Browser", icon: "safari.fill", isOn: $bridge.shareBrowser, tint: .orange)
                    AppToggleRow(title: "Terminal", icon: "terminal.fill", isOn: $bridge.shareShell, tint: .orange)
                }
                .padding(.leading, 20)
            } else {
                Text("Files, browser, and terminal access.")
                    .font(.caption2).foregroundColor(.secondary.opacity(0.7)).padding(.leading, 22)
            }

            Divider()

            AppToggleRow(title: "Keep Mac Awake", icon: "bolt.fill", isOn: $bridge.keepAwake)
            AppToggleRow(title: "Launch at Login", icon: "sunrise.fill", isOn: $bridge.launchAtLogin)

            HStack(spacing: 14) {
                Button(action: { openWindow(id: "onboarding") }) {
                    HStack(spacing: 5) { Image(systemName: "checklist").font(.system(size: 10)); Text("Set up Mac access").font(.caption) }
                        .foregroundColor(.secondary)
                }
                Button(action: { NSWorkspace.shared.open(stack.logsDir) }) {
                    HStack(spacing: 5) { Image(systemName: "doc.text").font(.system(size: 10)); Text("Logs").font(.caption) }
                        .foregroundColor(.secondary)
                }
            }
            .buttonStyle(.plain)

            Divider()

            HStack {
                Spacer()
                Button("Quit ClosedHand") { NSApp.terminate(nil) }
                    .font(.caption).foregroundColor(.secondary).keyboardShortcut("q")
            }
        }
        .padding(12)
        .frame(width: 270)
        .animation(.easeOut(duration: 0.2), value: bridge.unrestrictedMode)
        .onReceive(permissionTimer) { _ in permissionRefresh.toggle() }
        .alert("Enable Computer Control?", isPresented: $showComputerControlAlert) {
            Button("Cancel", role: .cancel) {}
            Button("Enable") { bridge.unrestrictedMode = true; bridge.saveSettings() }
        } message: {
            Text("ClosedHand will be able to access your files, control your browser, and run terminal commands. You can turn this off at any time.")
        }
    }

    private var overall: Color {
        if [stack.database, stack.bot, stack.web].allSatisfy({ $0 == .running }) { return .green }
        if [stack.database, stack.bot, stack.web].contains(where: { if case .failed = $0 { return true }; return false }) { return .red }
        return .orange
    }

    private func row(_ name: String, _ state: ServiceState) -> some View {
        HStack(spacing: 8) {
            Circle().fill(colour(state)).frame(width: 7, height: 7)
            Text(name).font(.subheadline)
            Spacer()
            Text(state.label).font(.caption).foregroundColor(.secondary)
                .lineLimit(1).truncationMode(.tail).frame(maxWidth: 140, alignment: .trailing).help(state.label)
        }
    }

    private func colour(_ state: ServiceState) -> Color {
        switch state {
        case .running: return .green
        case .starting: return .orange
        case .stopped: return .gray
        case .failed: return .red
        }
    }

    private var hasAccessibility: Bool { let _ = permissionRefresh; return AXIsProcessTrusted() }
    private var hasScreenRecording: Bool {
        let _ = permissionRefresh
        return CGWindowListCreateImage(CGRect(x: 0, y: 0, width: 1, height: 1), .optionOnScreenOnly, kCGNullWindowID, []) != nil
    }
}
