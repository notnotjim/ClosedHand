import Foundation
import EventKit
import AppKit

enum RemindersBridge {
    private static let store = EKEventStore()

    private static func ensureRemindersAccess() async -> Bool {
        if let granted = try? await store.requestFullAccessToReminders(), granted { return true }
        print("[RemindersBridge] Access denied, opening settings...")
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders") {
            NSWorkspace.shared.open(url)
        }
        for _ in 1...15 {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if let granted = try? await store.requestFullAccessToReminders(), granted { return true }
        }
        return false
    }

    static func listReminders(params: [String: Any]) async -> Any {
        guard await ensureRemindersAccess() else {
            return ["error": "Reminders access was not granted"]
        }

        let predicate = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: nil)

        return await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { reminders in
                let result = (reminders ?? []).prefix(50).map { reminder in
                    [
                        "title": reminder.title ?? "",
                        "dueDate": reminder.dueDateComponents?.date.map { ISO8601DateFormatter().string(from: $0) } ?? "",
                        "priority": reminder.priority,
                        "list": reminder.calendar.title,
                        "notes": reminder.notes ?? "",
                    ] as [String: Any]
                }
                continuation.resume(returning: result)
            }
        }
    }
}
