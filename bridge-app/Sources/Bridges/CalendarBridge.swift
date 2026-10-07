import Foundation
import EventKit

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
        if let events = eventKitEvents(daysBack: daysBack, daysAhead: daysAhead) { return events }

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

    /// Events read straight from the calendar store: fast, no Calendar app
    /// launch, exact times with their offset. Nil when Calendar access isn't
    /// granted, so the AppleScript path above still answers.
    private static func eventKitEvents(daysBack: Int, daysAhead: Int) -> [[String: Any]]? {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return nil }
        let store = EKEventStore()
        let now = Date()
        guard let from = Calendar.current.date(byAdding: .day, value: -daysBack, to: now),
              let to = Calendar.current.date(byAdding: .day, value: daysAhead, to: now) else { return nil }
        // Birthdays, suggestions and public holiday calendars are not the person's plans.
        let calendars = store.calendars(for: .event).filter { cal in
            cal.type != .birthday && !cal.title.localizedCaseInsensitiveContains("holiday")
                && !["Siri Suggestions", "Scheduled Reminders"].contains(cal.title)
        }
        if calendars.isEmpty { return [] }
        let iso = ISO8601DateFormatter()
        iso.timeZone = .current
        let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
        return store.events(matching: predicate).map { e in
            var event: [String: Any] = [
                // Stable across syncs: the same event keeps the same id.
                "id": (e.calendarItemExternalIdentifier ?? e.eventIdentifier ?? "") + "@" + iso.string(from: e.startDate),
                "title": e.title ?? "",
                "start": iso.string(from: e.startDate),
                "end": iso.string(from: e.endDate),
                "all_day": e.isAllDay,
                "location": e.location ?? "",
                "calendar": e.calendar.title,
                "notes": String((e.notes ?? "").prefix(2000)),
            ]
            if let attendees = e.attendees, !attendees.isEmpty {
                event["attendees"] = attendees.map { a in
                    a.name ?? a.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
                }
            }
            return event
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
