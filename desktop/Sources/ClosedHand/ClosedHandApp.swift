import SwiftUI
import AppKit

@main
struct ClosedHandApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var stack = Supervisor.shared

    var body: some Scene {
        MenuBarExtra {
            MenuView()
        } label: {
            Image(nsImage: MenuIcon.image)
        }
        .menuBarExtraStyle(.window)
    }
}

/// The fist from the wordmark as a template image, so it takes the menu
/// bar's own colour in light and dark.
enum MenuIcon {
    static let image: NSImage = {
        if let url = Bundle.module.url(forResource: "logo", withExtension: "png"), let img = NSImage(contentsOf: url) {
            img.isTemplate = true
            img.size = NSSize(width: 18, height: 18)
            return img
        }
        return NSImage(systemSymbolName: "hand.raised.fill", accessibilityDescription: "ClosedHand")!
    }()
}

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        Supervisor.shared.start()
    }

    /// Opening the app again while it runs (a Finder double-click, or the
    /// Launchpad icon) means "show me ClosedHand".
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if Supervisor.shared.web == .running { Supervisor.shared.openDashboard() }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Quit means the whole stack goes down cleanly: the node processes
        // first, then Postgres with a fast shutdown so the data is consistent.
        Supervisor.shared.stop()
        return .terminateNow
    }
}
