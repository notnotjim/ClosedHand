import Foundation
import Combine
import ServiceManagement
import EventKit
import Contacts

@MainActor
class BridgeManager: ObservableObject {
    static let shared = BridgeManager()

    @Published var isConnected = false
    @Published var isPaired = false
    @Published var pairingCode = ""
    @Published var serverUrl = "wss://closedhand.ai/bridge"

    // Activity indicator — shows when the bot is actively using the computer
    @Published var isActive = false
    @Published var lastAction = ""
    private var activityTimer: Timer?

    // Safe tier (on by default)
    @Published var shareCalendar = true
    @Published var shareReminders = true
    @Published var shareContacts = true
    @Published var shareNotes = true

    // Unrestricted Mode (off by default, gates dangerous permissions)
    @Published var unrestrictedMode = false
    @Published var shareFiles = true
    @Published var shareShell = true
    @Published var shareBrowser = true
    @Published var keepAwake = false {
        didSet {
            Task { let _ = await SystemBridge.keepAwake(params: ["enable": keepAwake]) }
            saveSettings()
        }
    }

    @Published var launchAtLogin = false {
        didSet {
            if launchAtLogin {
                try? SMAppService.mainApp.register()
            } else {
                try? SMAppService.mainApp.unregister()
            }
            saveSettings()
        }
    }

    private var webSocket: URLSessionWebSocketTask?
    private var userId: String?
    private var bridgeToken: String?
    private var connectionId: UUID = UUID() // Track which connection the ping loop belongs to

    private let defaults = UserDefaults.standard

    init() {
        loadSettings()
        if isPaired {
            connect()
        }
    }

    func loadSettings() {
        isPaired = defaults.bool(forKey: "isPaired")
        userId = defaults.string(forKey: "userId")
        bridgeToken = defaults.string(forKey: "bridgeToken")
        serverUrl = defaults.string(forKey: "serverUrl") ?? "wss://closedhand.ai/bridge"
        shareCalendar = defaults.object(forKey: "shareCalendar") == nil ? true : defaults.bool(forKey: "shareCalendar")
        shareReminders = defaults.object(forKey: "shareReminders") == nil ? true : defaults.bool(forKey: "shareReminders")
        shareContacts = defaults.object(forKey: "shareContacts") == nil ? true : defaults.bool(forKey: "shareContacts")
        shareNotes = defaults.object(forKey: "shareNotes") == nil ? true : defaults.bool(forKey: "shareNotes")
        shareFiles = defaults.object(forKey: "shareFiles") == nil ? true : defaults.bool(forKey: "shareFiles")
        shareShell = defaults.object(forKey: "shareShell") == nil ? true : defaults.bool(forKey: "shareShell")
        shareBrowser = defaults.object(forKey: "shareBrowser") == nil ? true : defaults.bool(forKey: "shareBrowser")
        unrestrictedMode = defaults.bool(forKey: "unrestrictedMode")
        keepAwake = defaults.bool(forKey: "keepAwake")
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    func saveSettings() {
        defaults.set(isPaired, forKey: "isPaired")
        defaults.set(userId, forKey: "userId")
        defaults.set(bridgeToken, forKey: "bridgeToken")
        defaults.set(serverUrl, forKey: "serverUrl")
        defaults.set(shareCalendar, forKey: "shareCalendar")
        defaults.set(shareReminders, forKey: "shareReminders")
        defaults.set(shareContacts, forKey: "shareContacts")
        defaults.set(shareNotes, forKey: "shareNotes")
        defaults.set(shareFiles, forKey: "shareFiles")
        defaults.set(shareShell, forKey: "shareShell")
        defaults.set(shareBrowser, forKey: "shareBrowser")
        defaults.set(unrestrictedMode, forKey: "unrestrictedMode")
        defaults.set(keepAwake, forKey: "keepAwake")
    }

    func startPairing() {
        // Generate a 6-char pairing code
        let chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        pairingCode = String((0..<6).map { _ in chars.randomElement()! })
        connect()
    }

    func unpair() {
        // Tell server we're disconnecting so dashboard updates
        sendJSON(["type": "disconnect"])
        DataSync.shared.stop()
        disconnect()
        isPaired = false
        userId = nil
        bridgeToken = nil
        pairingCode = ""
        saveSettings()
    }

    private func setActive(action: String) {
        isActive = true
        lastAction = action.replacingOccurrences(of: ".", with: " ").capitalized
        activityTimer?.invalidate()
    }

    private func clearActivityAfterDelay() {
        activityTimer?.invalidate()
        activityTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.isActive = false
                self?.lastAction = ""
            }
        }
    }

    func connect() {
        guard let url = URL(string: serverUrl) else { return }
        let session = URLSession(configuration: .default)
        webSocket = session.webSocketTask(with: url)
        webSocket?.resume()
        // Don't set isConnected yet. Wait for server to confirm auth.

        // New connection ID so stale ping loops stop
        let thisConnectionId = UUID()
        connectionId = thisConnectionId

        // Send auth/pairing message
        let authMsg: [String: Any] = [
            "type": isPaired ? "auth" : "pair",
            "token": bridgeToken ?? "",
            "code": pairingCode,
        ]
        sendJSON(authMsg)

        // Start listening
        listenForMessages()

        // Start keepalive pings every 15s
        startPing(forConnection: thisConnectionId)
    }

    private func startPing(forConnection id: UUID) {
        Task {
            while webSocket != nil && connectionId == id {
                try? await Task.sleep(for: .seconds(15))
                guard connectionId == id else { break }
                webSocket?.sendPing { error in
                    if let error {
                        print("Ping failed: \(error)")
                    }
                }
            }
        }
    }

    func disconnect() {
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        isConnected = false
    }

    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }
        webSocket?.send(.string(str)) { error in
            if let error { print("WS send error: \(error)") }
        }
    }

    private func listenForMessages() {
        webSocket?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    switch message {
                    case .string(let text):
                        self.handleMessage(text)
                    default:
                        break
                    }
                    self.listenForMessages() // Continue listening
                case .failure(let error):
                    print("WS receive error: \(error)")
                    self.isConnected = false
                    // Reconnect quickly so pending requests can retry
                    try? await Task.sleep(for: .seconds(2))
                    self.connect()
                }
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        switch type {
        case "paired":
            // Server confirmed pairing
            isConnected = true
            isPaired = true
            userId = json["userId"] as? String
            bridgeToken = json["token"] as? String
            pairingCode = ""
            saveSettings()
            DataSync.shared.start()

        case "request":
            // Server wants data
            let requestId = json["id"] as? String ?? ""
            let action = json["action"] as? String ?? ""
            Task {
                setActive(action: action)
                // 30s timeout: if a permission prompt blocks, return error instead of hanging
                let response: Any = await withTaskGroup(of: Any.self) { group in
                    group.addTask {
                        await self.handleRequest(action: action, params: json["params"] as? [String: Any] ?? [:])
                    }
                    group.addTask {
                        try? await Task.sleep(nanoseconds: 90_000_000_000)
                        return ["error": "Bridge timed out (90s)."] as Any
                    }
                    let result = await group.next()!
                    group.cancelAll()
                    return result
                }
                sendJSON([
                    "type": "response",
                    "id": requestId,
                    "data": response,
                ])
                clearActivityAfterDelay()
            }

        case "authenticated":
            // Server confirmed reconnection
            isConnected = true
            isPaired = true
            DataSync.shared.start()

        case "error":
            // Server rejected our token (pairing was deleted)
            isConnected = false
            isPaired = false
            bridgeToken = nil
            userId = nil
            pairingCode = ""
            saveSettings()
            disconnect()

        case "waiting":
            // Server acknowledged pairing code, waiting for dashboard confirmation
            break

        default:
            break
        }
    }

    /// Try primary method, fall back to Accessibility API if it returns an error.
    /// Works for any action on any app, not just specific ones.
    private func withFallback(_ primary: () async -> Any, axApp: String? = nil, axAction: String = "", params: [String: Any] = [:]) async -> Any {
        let result = await primary()
        if let dict = result as? [String: Any], dict["error"] != nil, AccessibilityBridge.hasPermission() {
            if let app = axApp {
                print("[Bridge] Primary failed, trying Accessibility fallback for \(axAction) in \(app)")
                return await AccessibilityBridge.readUI(params: ["app": app, "depth": 5])
            }
        }
        return result
    }

    private func handleRequest(action: String, params: [String: Any]) async -> Any {
        switch action {
        case "calendar.list":
            guard shareCalendar else { return ["error": "Calendar sharing disabled"] }
            return await CalendarBridge.listEvents(params: params)
        case "calendar.create":
            guard shareCalendar else { return ["error": "Calendar sharing disabled"] }
            return await CalendarBridge.createEvent(params: params)
        case "reminders.list":
            guard shareReminders else { return ["error": "Reminders sharing disabled"] }
            return await RemindersBridge.listReminders(params: params)
        case "contacts.search":
            guard shareContacts else { return ["error": "Contacts sharing disabled"] }
            return await ContactsBridge.search(params: params)
        case "notes.list":
            guard shareNotes else { return ["error": "Notes sharing disabled"] }
            return await withFallback({ await NotesBridge.listNotes(params: params) }, axApp: "Notes", axAction: "list", params: params)

        // File system
        case "files.list":
            guard shareFiles else { return ["error": "File access disabled"] }
            return await FileBridge.listFiles(params: params)
        case "files.read":
            guard shareFiles else { return ["error": "File access disabled"] }
            return await FileBridge.readFile(params: params)
        case "files.write":
            guard shareFiles else { return ["error": "File access disabled"] }
            guard unrestrictedMode else { return ["error": "File writing requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await FileBridge.writeFile(params: params)
        case "files.move":
            guard shareFiles else { return ["error": "File access disabled"] }
            guard unrestrictedMode else { return ["error": "File moving requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await FileBridge.moveFile(params: params)
        case "files.delete":
            guard shareFiles else { return ["error": "File access disabled"] }
            guard unrestrictedMode else { return ["error": "File deletion requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await FileBridge.deleteFile(params: params)
        case "files.info":
            guard shareFiles else { return ["error": "File access disabled"] }
            return await FileBridge.fileInfo(params: params)
        case "files.search":
            guard shareFiles else { return ["error": "File access disabled"] }
            return await FileBridge.searchFiles(params: params)
        case "files.edit":
            guard shareFiles else { return ["error": "File access disabled"] }
            guard unrestrictedMode else { return ["error": "File editing requires Unrestricted Mode."] }
            return await FileBridge.editFile(params: params)
        case "files.grep":
            guard shareFiles else { return ["error": "File access disabled"] }
            return await FileBridge.grepFiles(params: params)
        case "files.glob":
            guard shareFiles else { return ["error": "File access disabled"] }
            return await FileBridge.globFiles(params: params)

        // Shell
        case "shell.run":
            guard shareShell else { return ["error": "Shell access disabled"] }
            guard unrestrictedMode else { return ["error": "Shell commands require Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await ShellBridge.run(params: params)

        // Browser
        case "browser.active_tab":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            return await withFallback({ await BrowserBridge.activeTab(params: params) }, axApp: "Safari", axAction: "active_tab", params: params)
        case "browser.open_url":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            return await BrowserBridge.openURL(params: params)
        case "browser.page_content":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            return await BrowserBridge.pageContent(params: params)
        case "browser.list_tabs":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            return await BrowserBridge.listTabs(params: params)
        case "browser.execute_js":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            guard unrestrictedMode else { return ["error": "JavaScript execution requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await BrowserBridge.executeJS(params: params)
        case "browser.click":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            guard unrestrictedMode else { return ["error": "Browser interaction requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await BrowserBridge.clickElement(params: params)
        case "browser.type":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            guard unrestrictedMode else { return ["error": "Browser interaction requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await BrowserBridge.typeText(params: params)
        case "browser.switch_tab":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            return await BrowserBridge.switchTab(params: params)
        case "browser.close_tab":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            guard unrestrictedMode else { return ["error": "Closing tabs requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await BrowserBridge.closeTab(params: params)
        case "browser.navigate":
            guard shareBrowser else { return ["error": "Browser sharing disabled"] }
            guard unrestrictedMode else { return ["error": "Browser navigation requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await BrowserBridge.navigate(params: params)

        // System
        case "system.info":
            return await SystemBridge.info(params: params)
        case "system.screenshot":
            return await SystemBridge.screenshot(params: params)
        case "system.launch_app":
            return await SystemBridge.launchApp(params: params)
        case "system.clipboard_read":
            return await SystemBridge.clipboardRead(params: params)
        case "system.clipboard_write":
            guard unrestrictedMode else { return ["error": "Clipboard writing requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await SystemBridge.clipboardWrite(params: params)
        case "system.keep_awake":
            return await SystemBridge.keepAwake(params: params)

        // Accessibility (any app)
        case "ax.list_windows":
            return await AccessibilityBridge.listWindows(params: params)
        case "ax.focus_window":
            return await AccessibilityBridge.focusWindow(params: params)
        case "ax.read_ui":
            return await AccessibilityBridge.readUI(params: params)
        case "ax.click":
            guard unrestrictedMode else { return ["error": "Clicking UI elements requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await AccessibilityBridge.clickUI(params: params)
        case "ax.set_value":
            guard unrestrictedMode else { return ["error": "Setting UI values requires Unrestricted Mode. Ask the user to enable it in Bridge settings."] }
            return await AccessibilityBridge.setUIValue(params: params)

        // Persistent shell sessions (interactive CLI tools like claude, python, node)
        case "shell.session_start":
            guard shareShell else { return ["error": "Shell access disabled"] }
            guard unrestrictedMode else { return ["error": "Shell sessions require Unrestricted Mode."] }
            return await ShellBridge.sessionStart(params: params)
        case "shell.session_send":
            guard shareShell else { return ["error": "Shell access disabled"] }
            guard unrestrictedMode else { return ["error": "Shell sessions require Unrestricted Mode."] }
            return await ShellBridge.sessionSend(params: params)
        case "shell.session_read":
            guard shareShell else { return ["error": "Shell access disabled"] }
            return await ShellBridge.sessionRead(params: params)
        case "shell.session_end":
            guard shareShell else { return ["error": "Shell access disabled"] }
            return await ShellBridge.sessionEnd(params: params)
        case "shell.session_list":
            guard shareShell else { return ["error": "Shell access disabled"] }
            return await ShellBridge.sessionList(params: params)
        case "shell.session_type_to":
            guard shareShell else { return ["error": "Shell access disabled"] }
            guard unrestrictedMode else { return ["error": "Typing into apps requires Unrestricted Mode."] }
            return await ShellBridge.sessionTypeTo(params: params)
        case "shell.session_focus_terminal":
            guard shareShell else { return ["error": "Shell access disabled"] }
            return await ShellBridge.sessionFocusTerminal(params: params)

        // Raw input (mouse + keyboard) — visible to user, last resort
        case "input.mouse_move":
            guard unrestrictedMode else { return ["error": "Mouse control requires Unrestricted Mode."] }
            return await InputBridge.mouseMove(params: params)
        case "input.mouse_click":
            guard unrestrictedMode else { return ["error": "Mouse control requires Unrestricted Mode."] }
            return await InputBridge.mouseClick(params: params)
        case "input.mouse_drag":
            guard unrestrictedMode else { return ["error": "Mouse control requires Unrestricted Mode."] }
            return await InputBridge.mouseDrag(params: params)
        case "input.key_type":
            guard unrestrictedMode else { return ["error": "Keyboard control requires Unrestricted Mode."] }
            return await InputBridge.keyType(params: params)
        case "input.key_press":
            guard unrestrictedMode else { return ["error": "Keyboard control requires Unrestricted Mode."] }
            return await InputBridge.keyPress(params: params)
        case "input.key_combo":
            guard unrestrictedMode else { return ["error": "Keyboard control requires Unrestricted Mode."] }
            return await InputBridge.keyCombo(params: params)
        case "input.scroll":
            guard unrestrictedMode else { return ["error": "Scroll control requires Unrestricted Mode."] }
            return await InputBridge.scroll(params: params)

        default:
            return ["error": "Unknown action: \(action)"]
        }
    }
}
