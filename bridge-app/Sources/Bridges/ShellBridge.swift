import Foundation
import AppKit
import CoreGraphics

/// A persistent shell session that keeps a process alive for interactive use
class ShellSession {
    let name: String
    let process: Process
    let stdinPipe: Pipe
    let stdoutPipe: Pipe
    let stderrPipe: Pipe
    private var outputBuffer = ""
    private var errorBuffer = ""
    private let bufferLock = NSLock()
    let created: Date

    init(name: String, command: String, args: [String] = [], env: [String: String]? = nil) {
        self.name = name
        self.created = Date()
        self.process = Process()
        self.stdinPipe = Pipe()
        self.stdoutPipe = Pipe()
        self.stderrPipe = Pipe()

        process.executableURL = URL(fileURLWithPath: command)
        process.arguments = args
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        if let env = env {
            var fullEnv = ProcessInfo.processInfo.environment
            for (k, v) in env { fullEnv[k] = v }
            process.environment = fullEnv
        }

        // Read stdout asynchronously
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty, let str = String(data: data, encoding: .utf8) {
                self?.bufferLock.lock()
                self?.outputBuffer += str
                self?.bufferLock.unlock()
            }
        }

        stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if !data.isEmpty, let str = String(data: data, encoding: .utf8) {
                self?.bufferLock.lock()
                self?.errorBuffer += str
                self?.bufferLock.unlock()
            }
        }
    }

    func start() throws {
        try process.run()
    }

    var isRunning: Bool {
        return process.isRunning
    }

    func send(_ text: String) {
        let data = (text + "\n").data(using: .utf8)!
        stdinPipe.fileHandleForWriting.write(data)
    }

    func readOutput(waitMs: Int = 2000) -> (stdout: String, stderr: String) {
        // Wait for output to accumulate
        usleep(UInt32(waitMs) * 1000)

        bufferLock.lock()
        let out = outputBuffer
        let err = errorBuffer
        outputBuffer = ""
        errorBuffer = ""
        bufferLock.unlock()

        // Truncate if too large
        let maxSize = 50 * 1024
        let truncOut = out.utf8.count > maxSize ? String(out.prefix(maxSize)) + "\n...[truncated]" : out
        let truncErr = err.utf8.count > maxSize ? String(err.prefix(maxSize)) + "\n...[truncated]" : err

        return (truncOut, truncErr)
    }

    func terminate() {
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil
        if process.isRunning {
            process.terminate()
        }
    }
}

enum ShellBridge {
    private static let maxOutputSize = 50 * 1024 // 50KB
    private static let defaultTimeout: TimeInterval = 15

    // Persistent sessions keyed by name
    private static var sessions: [String: ShellSession] = [:]
    private static let sessionLock = NSLock()

    /// Commands/patterns that are blocked for safety
    private static let blockedPatterns: [String] = [
        "rm -rf /",
        "rm -rf /*",
        "rm -Rf /",
        "rm -Rf /*",
        "diskutil erase",
        "diskutil eraseDisk",
        "diskutil eraseVolume",
        "mkfs",
        "format",
        "dd if=",
        ":(){ :|:",  // fork bomb
        "> /dev/sd",
        "> /dev/disk",
        "chmod -R 000 /",
        "chown -R 0:0 /",
        "su -",
        "dsenableroot",
    ]

    private static func isCommandBlocked(_ command: String) -> Bool {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        for pattern in blockedPatterns {
            if trimmed.contains(pattern) {
                return true
            }
        }
        return false
    }

    private static func truncateOutput(_ output: String) -> String {
        if output.utf8.count > maxOutputSize {
            let truncated = String(output.prefix(maxOutputSize))
            return truncated + "\n... [output truncated at 50KB]"
        }
        return output
    }

    static func run(params: [String: Any]) async -> Any {
        guard let command = params["command"] as? String else {
            return ["error": "command required"]
        }

        if isCommandBlocked(command) {
            return ["error": "Command blocked for safety. Dangerous operations are not allowed."]
        }

        let timeout = params["timeout"] as? TimeInterval ?? defaultTimeout

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-c", command]

        // Run from user's home directory
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())

        // Set up environment without sudo
        var env = ProcessInfo.processInfo.environment
        env.removeValue(forKey: "SUDO_ASKPASS")
        process.environment = env

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return ["error": "Failed to start process: \(error.localizedDescription)"]
        }

        // Timeout handling
        let timedOut = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            var didResume = false
            let lock = NSLock()

            // Timeout watchdog
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                lock.lock()
                if !didResume {
                    didResume = true
                    lock.unlock()
                    process.terminate()
                    continuation.resume(returning: true)
                } else {
                    lock.unlock()
                }
            }

            // Wait for process to finish
            DispatchQueue.global().async {
                process.waitUntilExit()
                lock.lock()
                if !didResume {
                    didResume = true
                    lock.unlock()
                    continuation.resume(returning: false)
                } else {
                    lock.unlock()
                }
            }
        }

        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()

        let stdout = truncateOutput(String(data: stdoutData, encoding: .utf8) ?? "")
        let stderr = truncateOutput(String(data: stderrData, encoding: .utf8) ?? "")

        var exitCode: Int32 = -1
        if process.isRunning == false {
            do {
                let status = process.terminationStatus
                exitCode = status
            }
        }

        var result: [String: Any] = [
            "exitCode": Int(exitCode),
            "stdout": stdout,
            "stderr": stderr,
        ]

        if timedOut {
            result["timedOut"] = true
            result["error"] = "Command timed out after \(Int(timeout)) seconds"
        }

        return result
    }

    // MARK: - Persistent Sessions

    /// Start a named interactive session (e.g. "claude", "python", "node")
    static func sessionStart(params: [String: Any]) async -> Any {
        guard let name = params["name"] as? String else {
            return ["error": "session name required"]
        }
        let command = params["command"] as? String ?? "/bin/zsh"
        let args = params["args"] as? [String] ?? []

        sessionLock.lock()
        // Kill existing session with same name
        if let existing = sessions[name] {
            existing.terminate()
            sessions.removeValue(forKey: name)
        }
        sessionLock.unlock()

        let session = ShellSession(name: name, command: command, args: args)
        do {
            try session.start()
        } catch {
            return ["error": "Failed to start session: \(error.localizedDescription)"]
        }

        // Wait a moment for the process to start and produce initial output
        let output = session.readOutput(waitMs: 1500)

        sessionLock.lock()
        sessions[name] = session
        sessionLock.unlock()

        return [
            "status": "started",
            "name": name,
            "stdout": output.stdout,
            "stderr": output.stderr,
        ]
    }

    /// Send input to a named session and read the response
    static func sessionSend(params: [String: Any]) async -> Any {
        guard let name = params["name"] as? String else {
            return ["error": "session name required"]
        }
        guard let input = params["input"] as? String else {
            return ["error": "input text required"]
        }
        let waitMs = params["wait_ms"] as? Int ?? 3000

        sessionLock.lock()
        guard let session = sessions[name] else {
            sessionLock.unlock()
            return ["error": "No session named '\(name)'. Start one with shell.session_start first."]
        }
        sessionLock.unlock()

        guard session.isRunning else {
            sessionLock.lock()
            sessions.removeValue(forKey: name)
            sessionLock.unlock()
            return ["error": "Session '\(name)' has ended. Start a new one."]
        }

        // Drain any pending output first
        let _ = session.readOutput(waitMs: 100)

        // Send the input
        session.send(input)

        // Wait for response
        let output = session.readOutput(waitMs: waitMs)

        return [
            "name": name,
            "stdout": output.stdout,
            "stderr": output.stderr,
            "running": session.isRunning,
        ]
    }

    /// Read pending output from a session without sending anything
    static func sessionRead(params: [String: Any]) async -> Any {
        guard let name = params["name"] as? String else {
            return ["error": "session name required"]
        }
        let waitMs = params["wait_ms"] as? Int ?? 1000

        sessionLock.lock()
        guard let session = sessions[name] else {
            sessionLock.unlock()
            return ["error": "No session named '\(name)'."]
        }
        sessionLock.unlock()

        let output = session.readOutput(waitMs: waitMs)

        return [
            "name": name,
            "stdout": output.stdout,
            "stderr": output.stderr,
            "running": session.isRunning,
        ]
    }

    /// End a named session
    static func sessionEnd(params: [String: Any]) async -> Any {
        guard let name = params["name"] as? String else {
            return ["error": "session name required"]
        }

        sessionLock.lock()
        guard let session = sessions[name] else {
            sessionLock.unlock()
            return ["error": "No session named '\(name)'."]
        }
        session.terminate()
        sessions.removeValue(forKey: name)
        sessionLock.unlock()

        return ["status": "ended", "name": name]
    }

    /// Type into an existing terminal in a running app (e.g. VS Code, Terminal.app, iTerm)
    /// Uses CGEvent for keystrokes (requires Accessibility permission, NOT Automation permission).
    static func sessionTypeTo(params: [String: Any]) async -> Any {
        guard let app = params["app"] as? String else {
            return ["error": "app name required (e.g. 'Code', 'Terminal')"]
        }
        guard let text = params["text"] as? String else {
            return ["error": "text required"]
        }
        let pressEnter = params["press_enter"] as? Bool ?? true

        // Find and activate the app
        guard let runningApp = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName?.lowercased() == app.lowercased() ||
            $0.localizedName?.lowercased().contains(app.lowercased()) == true
        }) else {
            return ["error": "App not running: \(app)"]
        }

        // Force activate with multiple attempts and AX focus
        runningApp.activate(options: [.activateIgnoringOtherApps])
        usleep(500_000) // 500ms

        // Double-check it's actually frontmost, retry if not
        if !runningApp.isActive {
            runningApp.activate(options: [.activateIgnoringOtherApps])
            usleep(500_000)
        }

        // Use Accessibility API to raise the frontmost window and ensure keyboard focus
        let appElement = AXUIElementCreateApplication(runningApp.processIdentifier)
        var windowRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef) == .success {
            AXUIElementPerformAction(windowRef as! AXUIElement, kAXRaiseAction as CFString)
            usleep(200_000)
        }

        // Type using CGEvents (uses Accessibility permission, not Automation)
        for char in text {
            let str = String(char)
            let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            let chars = Array(str.utf16)
            event?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            event?.post(tap: .cghidEventTap)

            let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            upEvent?.post(tap: .cghidEventTap)
            usleep(15_000) // 15ms between keys
        }

        if pressEnter {
            usleep(50_000)
            let down = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true) // 36 = Return
            let up = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false)
            down?.post(tap: .cghidEventTap)
            usleep(50_000)
            up?.post(tap: .cghidEventTap)
        }

        return ["status": "typed", "app": app, "text": text, "enter": pressEnter]
    }

    /// Focus VS Code terminal panel using CGEvent keyboard shortcut (Ctrl+`)
    static func sessionFocusTerminal(params: [String: Any]) async -> Any {
        // Find and activate VS Code
        guard let runningApp = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName?.lowercased().contains("code") == true
        }) else {
            return ["error": "VS Code is not running"]
        }

        runningApp.activate()
        usleep(300_000) // 300ms

        // Press Ctrl+` to toggle terminal panel (key code 50 = backtick)
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 50, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 50, keyDown: false)
        down?.flags = .maskControl
        up?.flags = .maskControl
        down?.post(tap: .cghidEventTap)
        usleep(50_000)
        up?.post(tap: .cghidEventTap)
        usleep(200_000)

        return ["status": "focused", "note": "Terminal panel toggled. Use session_type_to to type into it, then bridge_screenshot to see the response."]
    }

    /// List active sessions
    static func sessionList(params: [String: Any]) async -> Any {
        sessionLock.lock()
        let list = sessions.map { (name, session) -> [String: Any] in
            return [
                "name": name,
                "running": session.isRunning,
                "uptime_seconds": Int(Date().timeIntervalSince(session.created)),
            ]
        }
        sessionLock.unlock()

        return ["sessions": list, "count": list.count]
    }
}
