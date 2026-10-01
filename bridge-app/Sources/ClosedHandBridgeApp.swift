import SwiftUI
import EventKit
import Contacts

@main
struct ClosedHandBridgeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var bridge = BridgeManager.shared

    var body: some Scene {
        MenuBarExtra("ClosedHand Bridge", systemImage: bridge.isActive ? "eye.fill" : (bridge.isConnected ? "link.circle.fill" : "link.circle")) {
            MenuBarView()
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
        }

        Window("Welcome to ClosedHand Bridge", id: "onboarding") {
            OnboardingContentView()
        }
        .windowStyle(.titleBar)
        .defaultSize(width: 380, height: 480)
        .windowResizability(.contentSize)
    }
}

struct OnboardingContentView: View {
    @State private var isComplete = UserDefaults.standard.bool(forKey: "onboardingComplete")

    var body: some View {
        if isComplete {
            VStack(spacing: 12) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 40))
                    .foregroundColor(.green)
                Text("Setup complete")
                    .font(.title3)
                Text("You can close this window. Bridge runs in the menu bar.")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding()
            .frame(width: 380, height: 200)
        } else {
            OnboardingView(isComplete: $isComplete)
        }
    }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Always start as accessory (no dock icon)
        NSApp.setActivationPolicy(.accessory)

        // Show onboarding window on first launch
        if !UserDefaults.standard.bool(forKey: "onboardingComplete") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                NSApp.activate(ignoringOtherApps: true)
                if let window = NSApp.windows.first(where: { $0.title.contains("Welcome") }) {
                    window.makeKeyAndOrderFront(nil)
                }
            }
        }

        // Pre-request Calendar/Reminders/Contacts permission on launch
        // Must temporarily become a regular app for macOS to show prompts
        Task { @MainActor in
            let store = EKEventStore()
            let calStatus = EKEventStore.authorizationStatus(for: .event)
            let remStatus = EKEventStore.authorizationStatus(for: .reminder)
            let conStatus = CNContactStore.authorizationStatus(for: .contacts)

            let needsAny = calStatus == .notDetermined || remStatus == .notDetermined || conStatus == .notDetermined
            if needsAny {
                // Briefly become a regular app so macOS shows permission prompts
                NSApp.setActivationPolicy(.regular)
                NSApp.activate(ignoringOtherApps: true)

                if calStatus == .notDetermined { let _ = try? await store.requestFullAccessToEvents() }
                if remStatus == .notDetermined { let _ = try? await store.requestFullAccessToReminders() }
                if conStatus == .notDetermined { let _ = try? await CNContactStore().requestAccess(for: .contacts) }

                // Switch back to accessory (menu bar only)
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                NSApp.setActivationPolicy(.accessory)
            }
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // Prevent dock icon from reappearing
        return false
    }
}
