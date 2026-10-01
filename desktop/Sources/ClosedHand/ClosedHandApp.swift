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

        // Bridge's permissions walkthrough, as it was: Accessibility, screen,
        // Automation, the apps. Opened from the menu, never forced.
        Window("Set up Mac access", id: "onboarding") {
            OnboardingHost()
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 380, height: 480)
        .windowResizability(.contentSize)
    }
}

struct OnboardingHost: View {
    @State private var isComplete = UserDefaults.standard.bool(forKey: "onboardingComplete")
    var body: some View {
        if isComplete {
            VStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 40)).foregroundColor(.green)
                Text("Mac access is set up").font(.title3)
                Text("Change what ClosedHand may use from the menu bar.").font(.caption).foregroundColor(.secondary)
            }
            .padding()
            .frame(width: 380, height: 200)
        } else {
            OnboardingView(isComplete: $isComplete)
        }
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
        // This app shares its defaults with the Bridge app it replaces. A
        // pairing Bridge made with some other ClosedHand must not be dialled
        // on launch; the Supervisor hands over the local one once it is up.
        UserDefaults.standard.set(false, forKey: "isPaired")
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
