import SwiftUI
import EventKit
import Contacts

struct OnboardingView: View {
    @StateObject private var bridge = BridgeManager.shared
    @Binding var isComplete: Bool

    @State private var currentStep = 0
    @State private var isGranting = false
    @State private var grantProgress = 0
    @State private var grantTotal = 0
    @State private var grantStatus: [String: Bool] = [:]

    private let steps = [
        OnboardingStep(
            icon: "hand.raised.circle.fill",
            title: "Your privacy comes first",
            body: "ClosedHand Bridge connects your Mac's apps to your ClosedHand assistant. All data is encrypted end to end and only accessible to your ClosedHand account. Nothing is sold or shared with third parties. You control exactly what is shared using the toggles in the menu bar, and you can wipe all your data from ClosedHand's servers at any time with two clicks.",
            action: nil
        ),
        OnboardingStep(
            icon: "accessibility.fill",
            title: "Enable Accessibility",
            body: "Bridge needs Accessibility permission to interact with apps on your behalf. This lets it read screens, press buttons, and fill forms, all invisibly in the background while you keep working.\n\nA System Settings window will open. Find ClosedHand Bridge in the list and toggle it on.",
            action: "accessibility"
        ),
        OnboardingStep(
            icon: "rectangle.dashed.badge.record",
            title: "Enable Screen Access",
            body: "Bridge needs Screen Recording permission to take screenshots of your screen so ClosedHand can see what you see and help you with what's on screen.\n\nA System Settings window will open. Find ClosedHand Bridge and toggle it on.",
            action: "screen_recording"
        ),
        OnboardingStep(
            icon: "app.badge.checkmark.fill",
            title: "Connect your apps",
            body: "Bridge will now connect to your apps. macOS will show a series of permission prompts. Tap Allow on each one to let ClosedHand work with that app.\n\nThis is a one-time setup. After this, you won't see these prompts again. Apps you don't have installed will be skipped automatically.",
            action: "automation"
        ),
    ]

    var body: some View {
        VStack(spacing: 0) {
            // Progress dots
            HStack(spacing: 8) {
                ForEach(0..<steps.count, id: \.self) { i in
                    Circle()
                        .fill(i <= currentStep ? Color.green : Color.gray.opacity(0.3))
                        .frame(width: 8, height: 8)
                }
            }
            .padding(.top, 20)
            .padding(.bottom, 16)

            // Content
            let step = steps[currentStep]

            ZStack {
                if let logoUrl = Bundle.module.url(forResource: "logo", withExtension: "png"),
                   let logoData = try? Data(contentsOf: logoUrl),
                   let nsImage = NSImage(data: logoData) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .frame(width: 36, height: 36)
                        .opacity(0.15)
                }
                Image(systemName: step.icon)
                    .font(.system(size: 40))
                    .foregroundColor(.green)
            }
            .padding(.bottom, 12)

            Text(step.title)
                .font(.title2)
                .fontWeight(.semibold)
                .padding(.bottom, 8)

            Text(step.body)
                .font(.body)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
                .fixedSize(horizontal: false, vertical: true)

            Spacer()

            // Grant progress (shown during automation step)
            if isGranting {
                VStack(spacing: 8) {
                    ProgressView(value: Double(grantProgress), total: Double(max(grantTotal, 1)))
                        .tint(.green)
                    ForEach(Array(grantStatus.keys.sorted()), id: \.self) { app in
                        HStack {
                            Image(systemName: grantStatus[app] == true ? "checkmark.circle.fill" : "circle")
                                .foregroundColor(grantStatus[app] == true ? .green : .gray)
                                .font(.caption)
                            Text(app)
                                .font(.caption)
                                .foregroundColor(.secondary)
                            Spacer()
                        }
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 12)
            }

            // Button
            Button(action: { handleAction(step.action) }) {
                Text(buttonLabel(for: step.action))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            .disabled(isGranting)
            .padding(.horizontal, 24)
            .padding(.bottom, 8)

            // Skip
            if currentStep < steps.count - 1 {
                Button("Skip setup") {
                    completeOnboarding()
                }
                .font(.caption)
                .foregroundColor(.secondary)
                .padding(.bottom, 12)
            } else if !isGranting {
                Button("I'll do this later") {
                    completeOnboarding()
                }
                .font(.caption)
                .foregroundColor(.secondary)
                .padding(.bottom, 12)
            }
        }
        .frame(width: 380, height: 480)
    }

    private func buttonLabel(for action: String?) -> String {
        switch action {
        case "accessibility": return "Open System Settings"
        case "automation": return isGranting ? "Granting permissions..." : "Grant App Permissions"
        default: return currentStep < steps.count - 1 ? "Continue" : "Done"
        }
    }

    private func handleAction(_ action: String?) {
        switch action {
        case "accessibility":
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
                NSWorkspace.shared.open(url)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                currentStep += 1
            }

        case "screen_recording":
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                NSWorkspace.shared.open(url)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                currentStep += 1
            }

        case "automation":
            triggerAllPermissions()

        default:
            if currentStep < steps.count - 1 {
                currentStep += 1
            } else {
                completeOnboarding()
            }
        }
    }

    private func triggerAllPermissions() {
        isGranting = true
        let apps = ["System Events", "Finder", "Safari", "Notes", "Chrome", "Terminal", "iTerm", "Preview", "Messages", "Music", "Pages", "Numbers", "Keynote", "TextEdit", "Outlook", "Word", "Excel", "Slack", "Spotify", "Calendar", "Reminders", "Contacts"]
        grantTotal = apps.count
        grantProgress = 0
        grantStatus = Dictionary(uniqueKeysWithValues: apps.map { ($0, false) })

        Task {
            // Calendar + Reminders + Contacts (framework-based, not AppleScript)
            let eventStore = EKEventStore()
            let _ = try? await eventStore.requestFullAccessToEvents()
            await MainActor.run { grantStatus["Calendar"] = true; grantProgress += 1 }

            let _ = try? await eventStore.requestFullAccessToReminders()
            await MainActor.run { grantStatus["Reminders"] = true; grantProgress += 1 }

            let contactStore = CNContactStore()
            let _ = try? await contactStore.requestAccess(for: .contacts)
            await MainActor.run { grantStatus["Contacts"] = true; grantProgress += 1 }

            // AppleScript-based apps (triggers automation prompts)
            // Covers all apps the Bridge might control via AppleScript
            let scriptApps: [(String, String)] = [
                ("System Events", "tell application \"System Events\" to get name"),
                ("Finder", "tell application \"Finder\" to get name"),
                ("Safari", "tell application \"Safari\" to get name"),
                ("Notes", "tell application \"Notes\" to get name"),
                ("Google Chrome", "tell application \"Google Chrome\" to get name"),
                ("Terminal", "tell application \"Terminal\" to get name"),
                ("iTerm", "tell application \"iTerm\" to get name"),
                ("Preview", "tell application \"Preview\" to get name"),
                ("Messages", "tell application \"Messages\" to get name"),
                ("Music", "tell application \"Music\" to get name"),
                ("Pages", "tell application \"Pages\" to get name"),
                ("Numbers", "tell application \"Numbers\" to get name"),
                ("Keynote", "tell application \"Keynote\" to get name"),
                ("TextEdit", "tell application \"TextEdit\" to get name"),
                ("Microsoft Outlook", "tell application \"Microsoft Outlook\" to get name"),
                ("Microsoft Word", "tell application \"Microsoft Word\" to get name"),
                ("Microsoft Excel", "tell application \"Microsoft Excel\" to get name"),
                ("Slack", "tell application \"Slack\" to get name"),
                ("Spotify", "tell application \"Spotify\" to get name"),
            ]

            for (appName, source) in scriptApps {
                // Run each in a task with timeout so missing apps don't block
                let granted = await withTaskGroup(of: Bool.self) { group in
                    group.addTask {
                        if let script = NSAppleScript(source: source) {
                            var err: NSDictionary?
                            script.executeAndReturnError(&err)
                            return err == nil
                        }
                        return false
                    }
                    group.addTask {
                        try? await Task.sleep(nanoseconds: 3_000_000_000) // 3s timeout
                        return false
                    }
                    // Return first result (either success or timeout)
                    let result = await group.next() ?? false
                    group.cancelAll()
                    return result
                }
                await MainActor.run {
                    grantStatus[appName] = granted
                    grantProgress += 1
                }
                try? await Task.sleep(nanoseconds: 300_000_000)
            }

            await MainActor.run {
                isGranting = false
                completeOnboarding()
            }
        }
    }

    private func completeOnboarding() {
        UserDefaults.standard.set(true, forKey: "onboardingComplete")
        isComplete = true
    }
}

struct OnboardingStep {
    let icon: String
    let title: String
    let body: String
    let action: String?
}
