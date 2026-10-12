// The Mac app's own secrets (the database password, the encryption key and
// the keys its services share) live in the login Keychain, which macOS keeps
// encrypted and opens only to this app without asking. They are read at
// launch and handed to the services in their environment, never written to
// a file. Supervisor.loadConfig moves them out of config.env, where earlier
// versions kept them.

import Foundation
import Security

enum Keychain {
    private static let service = "com.closedhand.app.secrets"

    private static func query(_ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: name]
    }

    static func get(_ name: String) -> String? {
        var q = query(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// True once the value is stored and reads back the same.
    @discardableResult
    static func set(_ name: String, _ value: String) -> Bool {
        let data = Data(value.utf8)
        var status = SecItemUpdate(query(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(name)
            add[kSecValueData as String] = data
            add[kSecAttrLabel as String] = "Closedhand \(name)"
            status = SecItemAdd(add as CFDictionary, nil)
        }
        return status == errSecSuccess && get(name) == value
    }
}
