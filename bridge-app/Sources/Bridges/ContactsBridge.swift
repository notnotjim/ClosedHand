import Foundation
import Contacts
import AppKit

enum ContactsBridge {
    private static let store = CNContactStore()

    private static func ensureContactsAccess() async -> Bool {
        if (try? await store.requestAccess(for: .contacts)) != nil && CNContactStore.authorizationStatus(for: .contacts) == .authorized { return true }
        print("[ContactsBridge] Access denied, opening settings...")
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts") {
            NSWorkspace.shared.open(url)
        }
        for _ in 1...15 {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if CNContactStore.authorizationStatus(for: .contacts) == .authorized { return true }
        }
        return false
    }

    static func search(params: [String: Any]) async -> Any {
        let query = params["query"] as? String ?? ""

        guard await ensureContactsAccess() else {
            return ["error": "Contacts access was not granted"]
        }

        let keysToFetch: [CNKeyDescriptor] = [
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactEmailAddressesKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactJobTitleKey as CNKeyDescriptor,
        ]

        let request = CNContactFetchRequest(keysToFetch: keysToFetch)
        if !query.isEmpty {
            request.predicate = CNContact.predicateForContacts(matchingName: query)
        }

        var results: [[String: Any]] = []
        do {
            try store.enumerateContacts(with: request) { contact, stop in
                if results.count >= 50 { stop.pointee = true; return }
                results.append([
                    "name": "\(contact.givenName) \(contact.familyName)".trimmingCharacters(in: .whitespaces),
                    "email": contact.emailAddresses.first?.value as String? ?? "",
                    "phone": contact.phoneNumbers.first?.value.stringValue ?? "",
                    "company": contact.organizationName,
                    "title": contact.jobTitle,
                ])
            }
        } catch {
            return ["error": error.localizedDescription]
        }

        return results
    }
}
