import Foundation

enum CalendarBridge {
    /// Run AppleScript via ShellBridge (proven TCC-compatible path)
    private static func shellScript(_ script: String, timeout: TimeInterval = 30) async -> String? {
        let tmpFile = NSTemporaryDirectory() + "closedhand_cal_\(Int(Date().timeIntervalSince1970))_\(Int.random(in: 1000...9999)).scpt"
        do { try script.write(toFile: tmpFile, atomically: true, encoding: .utf8) }
        catch { return nil }
        defer { try? FileManager.default.removeItem(atPath: tmpFile) }

        let result = await ShellBridge.run(params: ["command": "osascript '\(tmpFile)'", "timeout": timeout])
        if let dict = result as? [String: Any] {
            let stdout = dict["stdout"] as? String ?? ""
            if !stdout.isEmpty {
                return stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return nil
    }

    static func listEvents(params: [String: Any]) async -> Any {
        let daysBack = params["days_back"] as? Int ?? 0
        let daysAhead = params["days_ahead"] as? Int ?? 7

        let script = """
        tell application "Calendar"
            set output to ""
            repeat with cal in calendars
                set calName to name of cal
                set evts to (every event of cal whose start date >= ((current date) - (\(daysBack) * days)) and start date <= ((current date) + (\(daysAhead) * days)))
                repeat with e in evts
                    set sd to start date of e as string
                    set ed to end date of e as string
                    set t to summary of e
                    set loc to location of e
                    if loc is missing value then set loc to ""
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
                    set output to output & t & "|||" & sd & "|||" & ed & "|||" & loc & "|||" & calName & "|||" & n & "|||" & attList & linefeed
                end repeat
            end repeat
            return output
        end tell
        """

        guard let raw = await shellScript(script, timeout: 30), !raw.isEmpty else {
            return [] as [Any]
        }

        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        return lines.map { line -> [String: Any] in
            let parts = line.components(separatedBy: "|||")
            var dict: [String: Any] = [
                "title": parts.count > 0 ? parts[0] : "",
                "start": parts.count > 1 ? parts[1] : "",
                "end": parts.count > 2 ? parts[2] : "",
                "location": parts.count > 3 ? parts[3] : "",
                "calendar": parts.count > 4 ? parts[4] : "",
                "notes": parts.count > 5 ? parts[5] : "",
            ]
            if parts.count > 6 && !parts[6].isEmpty {
                dict["attendees"] = parts[6].components(separatedBy: ", ")
            }
            return dict
        }
    }

    static func createEvent(params: [String: Any]) async -> Any {
        guard let title = params["title"] as? String,
              let startStr = params["start"] as? String,
              let endStr = params["end"] as? String else {
            return ["error": "title, start, end required"]
        }
        let location = (params["location"] as? String ?? "").replacingOccurrences(of: "\"", with: "\\\"")
        let notes = (params["notes"] as? String ?? "").replacingOccurrences(of: "\"", with: "\\\"")
        let escapedTitle = title.replacingOccurrences(of: "\"", with: "\\\"")

        let script = """
        tell application "Calendar"
            set newEvent to make new event at end of events of default calendar with properties {summary:"\(escapedTitle)", start date:date "\(startStr)", end date:date "\(endStr)", location:"\(location)", description:"\(notes)"}
            return summary of newEvent
        end tell
        """

        guard let result = await shellScript(script, timeout: 15) else {
            return ["error": "Could not create event"]
        }
        return ["success": true, "title": result]
    }
}
