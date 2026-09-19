import SwiftUI

struct MenuView: View {
    @ObservedObject private var stack = Supervisor.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if let url = Bundle.module.url(forResource: "logo", withExtension: "png"), let img = NSImage(contentsOf: url) {
                    Image(nsImage: img).resizable().frame(width: 20, height: 20).opacity(0.9)
                }
                Text("ClosedHand").font(.headline)
                Spacer()
                Circle().fill(overall).frame(width: 8, height: 8)
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                row("Database", stack.database)
                row("ClosedHand", stack.bot)
                row("Dashboard", stack.web)
            }

            if !stack.address.isEmpty {
                Text(stack.address)
                    .font(.caption.monospaced())
                    .foregroundColor(.secondary)
            }

            Divider()

            Button(action: { stack.openDashboard() }) {
                Label("Open ClosedHand", systemImage: "safari")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .disabled(stack.web != .running)

            Button(action: { NSWorkspace.shared.open(stack.logsDir) }) {
                Label("Show logs", systemImage: "doc.text.magnifyingglass")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Divider()

            Button(action: { NSApp.terminate(nil) }) {
                Label("Quit ClosedHand", systemImage: "power")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .keyboardShortcut("q")
        }
        .buttonStyle(.plain)
        .padding(12)
        .frame(width: 260)
    }

    private var overall: Color {
        if [stack.database, stack.bot, stack.web].allSatisfy({ $0 == .running }) { return .green }
        if [stack.database, stack.bot, stack.web].contains(where: { if case .failed = $0 { return true }; return false }) { return .red }
        return .orange
    }

    private func row(_ name: String, _ state: ServiceState) -> some View {
        HStack(spacing: 8) {
            Circle().fill(colour(state)).frame(width: 7, height: 7)
            Text(name).font(.callout)
            Spacer()
            Text(state.label)
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 140, alignment: .trailing)
                .help(state.label)
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
}
