import AppKit
import Sparkle

/// Keeps Closedhand for Mac up to date with Sparkle. Once a day it looks at
/// the newest release's update feed (SUFeedURL in Info.plist), downloads an
/// update in the background (usually just the difference from this version)
/// and installs it as soon as Closedhand is between replies, restarting
/// itself. Nobody is asked: the data lives outside the app and carries
/// straight on. An update installs only if it is signed with the key whose
/// public half is SUPublicEDKey.
final class Updater: NSObject, SPUUpdaterDelegate {
    static let shared = Updater()

    private var controller: SPUStandardUpdaterController?
    private var install: (() -> Void)?
    private var idleTimer: Timer?

    func start() {
        let c = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
        c.updater.automaticallyChecksForUpdates = true
        c.updater.automaticallyDownloadsUpdates = true
        controller = c
    }

    /// The menu's "Check for updates": Sparkle says what it finds.
    func checkNow() { controller?.checkForUpdates(nil) }

    // Downloaded and ready. Sparkle would install it at the next quit; a
    // menu-bar app is rarely quit, so it goes in as soon as Closedhand is
    // idle instead, looked at once a minute.
    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock: @escaping () -> Void) -> Bool {
        install = immediateInstallationBlock
        idleTimer?.invalidate()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Supervisor.shared.isIdle { idle in
                guard idle, let self, let go = self.install else { return }
                self.idleTimer?.invalidate()
                self.install = nil
                go()
            }
        }
        return true
    }
}
