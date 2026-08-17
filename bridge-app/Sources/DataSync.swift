import Foundation

/// Pushes calendar data directly to the server on a timer.
/// Replaces the slow pull-based shell.run relay approach.
class DataSync {
    static let shared = DataSync()

    private var timer: Timer?
    private var isSyncing = false

    /// Start the background sync loop.
    /// Initial sync 30s after start, then every 10 minutes.
    func start() {
        guard timer == nil else { return }
        print("[DataSync] Starting push sync")
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            Task { await self.sync() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { _ in
            Task { await self.sync() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        print("[DataSync] Stopped push sync")
    }

    /// Run a full sync cycle: fetch calendar, push to server.
    func sync() async {
        guard !isSyncing else {
            print("[DataSync] Already syncing, skipping")
            return
        }
        isSyncing = true
        defer { isSyncing = false }

        let (isConn, isPaired, shareCal) = await MainActor.run {
            let m = BridgeManager.shared
            return (m.isConnected, m.isPaired, m.shareCalendar)
        }
        guard isConn, isPaired else {
            print("[DataSync] Not connected/paired, skipping sync")
            return
        }

        print("[DataSync] Starting sync cycle")

        var items: [[String: Any]] = []

        // Fetch calendar events if calendar sharing is enabled
        if shareCal {
            let events = await fetchCalendarEvents()
            items.append(contentsOf: events)
            print("[DataSync] Fetched \(events.count) calendar events")
        }

        if items.isEmpty {
            print("[DataSync] No items to push")
            return
        }

        let success = await pushToServer(items: items)
        print("[DataSync] Push \(success ? "succeeded" : "failed") (\(items.count) items)")
    }

    // MARK: - Calendar Fetch

    /// Fetch calendar events for -7d to +30d via osascript subprocess.
    /// Same approach as CalendarBridge, skipping holiday calendars.
    private func fetchCalendarEvents() async -> [[String: Any]] {
        let script = """
        tell application "Calendar"
            set output to ""
            set skipCals to {"United States holidays", "Holidays in the United Kingdom", "Holidays in United Kingdom", "UK Holidays", "Birthdays", "Siri Suggestions", "Scheduled Reminders"}
            repeat with cal in calendars
                set calName to name of cal
                if calName is not in skipCals then
                    set evts to (every event of cal whose start date >= ((current date) - (7 * days)) and start date <= ((current date) + (30 * days)))
                    repeat with e in evts
                        set sd to start date of e as string
                        set ed to end date of e as string
                        set t to summary of e
                        set loc to location of e
                        if loc is missing value then set loc to ""
                        set uid to uid of e
                        set n to description of e
                        if n is missing value then set n to ""
                        set attList to ""
                        try
                            set attNames to {}
                            repeat with a in attendees of e
                                set end of attNames to display name of a
                            end repeat
                            set AppleScript's text item delimiters to ", "
                            set attList to attNames as string
                            set AppleScript's text item delimiters to ""
                        end try
                        set output to output & uid & "|||" & t & "|||" & sd & "|||" & ed & "|||" & loc & "|||" & calName & "|||" & n & "|||" & attList & (ASCII character 10)
                    end repeat
                end if
            end repeat
            return output
        end tell
        """

        guard let raw = await runDirectAppleScript(script, timeout: 60) else {
            print("[DataSync] Calendar fetch returned nil")
            return []
        }

        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty && $0.contains("|||") }
        return lines.map { line -> [String: Any] in
            let parts = line.components(separatedBy: "|||")
            return [
                "source": "mac_calendar",
                "type": "event",
                "external_id": parts.count > 0 ? parts[0].trimmingCharacters(in: .whitespaces) : "",
                "data": [
                    "id": parts.count > 0 ? parts[0].trimmingCharacters(in: .whitespaces) : "",
                    "uid": parts.count > 0 ? parts[0].trimmingCharacters(in: .whitespaces) : "",
                    "summary": parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : "",
                    "start": parts.count > 2 ? parts[2].trimmingCharacters(in: .whitespaces) : "",
                    "end": parts.count > 3 ? parts[3].trimmingCharacters(in: .whitespaces) : "",
                    "location": parts.count > 4 ? parts[4].trimmingCharacters(in: .whitespaces) : "",
                    "calendar": parts.count > 5 ? parts[5].trimmingCharacters(in: .whitespaces) : "Mac Calendar",
                    "notes": parts.count > 6 ? parts[6].trimmingCharacters(in: .whitespaces) : "",
                    "attendees": parts.count > 7 ? parts[7].trimmingCharacters(in: .whitespaces) : "",
                    "date": parts.count > 2 ? parts[2].trimmingCharacters(in: .whitespaces) : "",
                ] as [String: Any],
                "received_at": parts.count > 2 ? parts[2].trimmingCharacters(in: .whitespaces) : "",
            ]
        }
    }

    // MARK: - Push to Server

    /// POST items to the webapp sync-cache endpoint.
    private func pushToServer(items: [[String: Any]]) async -> Bool {
        let serverUrl = await MainActor.run { BridgeManager.shared.serverUrl }
        guard let token = getBridgeToken() else {
            print("[DataSync] No bridge token available")
            return false
        }

        // Derive HTTPS base URL from the WebSocket server URL
        // wss://closedhand.ai/bridge -> https://closedhand.ai
        let baseUrl = serverUrl
            .replacingOccurrences(of: "wss://", with: "https://")
            .replacingOccurrences(of: "ws://", with: "http://")
            .replacingOccurrences(of: "/bridge", with: "")

        let urlString = baseUrl + "/api/bridge/sync-cache"
        guard let url = URL(string: urlString) else {
            print("[DataSync] Invalid URL: \(urlString)")
            return false
        }

        let body: [String: Any] = ["items": items]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: body) else {
            print("[DataSync] Failed to serialize JSON")
            return false
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = jsonData
        request.timeoutInterval = 30

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let httpResp = response as? HTTPURLResponse {
                if httpResp.statusCode == 200 {
                    return true
                } else {
                    let body = String(data: data, encoding: .utf8) ?? ""
                    print("[DataSync] Server returned \(httpResp.statusCode): \(body.prefix(200))")
                    return false
                }
            }
            return false
        } catch {
            print("[DataSync] Push error: \(error.localizedDescription)")
            return false
        }
    }

    // MARK: - Helpers

    /// Run AppleScript via NSAppleScript (Bridge's own process, most reliable).
    private func runDirectAppleScript(_ script: String, timeout: TimeInterval = 60) async -> String? {
        return await runAppleScriptAsync(script, timeout: timeout) as? String
    }

    /// Access the bridge token from UserDefaults (same store as BridgeManager).
    private func getBridgeToken() -> String? {
        return UserDefaults.standard.string(forKey: "bridgeToken")
    }
}
