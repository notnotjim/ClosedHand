import Foundation
import AppKit
import ApplicationServices

enum AccessibilityBridge {

    // MARK: - Check if we have Accessibility permission

    static func hasPermission() -> Bool {
        return AXIsProcessTrusted()
    }

    /// Open settings and wait up to 30s for user to grant permission
    static func ensurePermission() async -> Bool {
        if hasPermission() { return true }

        // Open the settings page
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        NSWorkspace.shared.open(url)

        // Poll for up to 30 seconds (user might grant it while settings is open)
        for _ in 1...15 {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if AXIsProcessTrusted() { return true }
        }
        return AXIsProcessTrusted()
    }

    // MARK: - List windows across all apps

    static func listWindows(params: [String: Any]) async -> Any {
        guard await ensurePermission() else {
            return ["error": "Accessibility permission was not granted. System Settings was opened but the permission was not enabled within 30 seconds."]
        }

        let appFilter = params["app"] as? String

        var windows: [[String: Any]] = []
        let runningApps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }

        for app in runningApps {
            if let filter = appFilter, !app.localizedName!.lowercased().contains(filter.lowercased()) {
                continue
            }

            let appElement = AXUIElementCreateApplication(app.processIdentifier)
            var windowsRef: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef)

            if result == .success, let axWindows = windowsRef as? [AXUIElement] {
                for (i, axWindow) in axWindows.enumerated() {
                    var titleRef: CFTypeRef?
                    AXUIElementCopyAttributeValue(axWindow, kAXTitleAttribute as CFString, &titleRef)
                    let title = titleRef as? String ?? "Untitled"

                    var posRef: CFTypeRef?
                    var sizeRef: CFTypeRef?
                    var pos = CGPoint.zero
                    var size = CGSize.zero
                    if AXUIElementCopyAttributeValue(axWindow, kAXPositionAttribute as CFString, &posRef) == .success {
                        AXValueGetValue(posRef as! AXValue, .cgPoint, &pos)
                    }
                    if AXUIElementCopyAttributeValue(axWindow, kAXSizeAttribute as CFString, &sizeRef) == .success {
                        AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
                    }

                    windows.append([
                        "app": app.localizedName ?? "Unknown",
                        "title": title,
                        "index": i,
                        "pid": Int(app.processIdentifier),
                        "x": Int(pos.x), "y": Int(pos.y),
                        "width": Int(size.width), "height": Int(size.height),
                    ])
                }
            }
        }

        return ["windows": windows, "count": windows.count]
    }

    // MARK: - Focus a window

    static func focusWindow(params: [String: Any]) async -> Any {
        guard await ensurePermission() else {
            return ["error": "Accessibility permission not granted"]
        }

        guard let appName = params["app"] as? String else {
            return ["error": "app name required"]
        }
        let windowIndex = params["index"] as? Int ?? 0

        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName?.lowercased() == appName.lowercased()
        }) else {
            return ["error": "App not running: \(appName)"]
        }

        app.activate()

        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        var windowsRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef) == .success,
           let axWindows = windowsRef as? [AXUIElement],
           windowIndex < axWindows.count {
            AXUIElementPerformAction(axWindows[windowIndex], kAXRaiseAction as CFString)
        }

        return ["status": "focused", "app": appName]
    }

    // MARK: - Read UI elements from an app

    static func readUI(params: [String: Any]) async -> Any {
        guard await ensurePermission() else {
            return ["error": "Accessibility permission not granted"]
        }

        guard let appName = params["app"] as? String else {
            return ["error": "app name required"]
        }
        let maxDepth = params["depth"] as? Int ?? 3

        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName?.lowercased() == appName.lowercased()
        }) else {
            return ["error": "App not running: \(appName)"]
        }

        let appElement = AXUIElementCreateApplication(app.processIdentifier)

        // Get the focused window
        var windowRef: CFTypeRef?
        AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef)
        let rootElement = windowRef != nil ? (windowRef as! AXUIElement) : appElement

        var elements: [[String: Any]] = []
        readElementTree(rootElement, depth: 0, maxDepth: maxDepth, elements: &elements, maxElements: 200)

        return ["elements": elements, "count": elements.count, "app": appName]
    }

    private static func readElementTree(_ element: AXUIElement, depth: Int, maxDepth: Int, elements: inout [[String: Any]], maxElements: Int) {
        guard depth < maxDepth, elements.count < maxElements else { return }

        var roleRef: CFTypeRef?
        var titleRef: CFTypeRef?
        var valueRef: CFTypeRef?
        var descRef: CFTypeRef?

        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef)
        AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &valueRef)
        AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &descRef)

        let role = roleRef as? String ?? ""
        let title = titleRef as? String ?? ""
        let value = (valueRef as? String) ?? ""
        let desc = descRef as? String ?? ""

        // Only include meaningful elements
        if !role.isEmpty && (!title.isEmpty || !value.isEmpty || !desc.isEmpty ||
            ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXPopUpButton",
             "AXMenuItem", "AXLink", "AXStaticText", "AXImage"].contains(role)) {
            var info: [String: Any] = ["role": role, "depth": depth]
            if !title.isEmpty { info["title"] = title }
            if !value.isEmpty { info["value"] = String(value.prefix(200)) }
            if !desc.isEmpty { info["description"] = desc }
            elements.append(info)
        }

        // Recurse into children
        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            for child in children {
                readElementTree(child, depth: depth + 1, maxDepth: maxDepth, elements: &elements, maxElements: maxElements)
            }
        }
    }

    // MARK: - Click a UI element by role + title/description

    static func clickUI(params: [String: Any]) async -> Any {
        guard await ensurePermission() else {
            return ["error": "Accessibility permission not granted"]
        }

        guard let appName = params["app"] as? String else {
            return ["error": "app name required"]
        }
        let targetTitle = params["title"] as? String
        let targetRole = params["role"] as? String ?? "AXButton"
        let targetDesc = params["description"] as? String

        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName?.lowercased() == appName.lowercased()
        }) else {
            return ["error": "App not running: \(appName)"]
        }

        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        var windowRef: CFTypeRef?
        AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef)
        let root = windowRef != nil ? (windowRef as! AXUIElement) : appElement

        if let found = findElement(root, role: targetRole, title: targetTitle, description: targetDesc, maxDepth: 8) {
            let result = AXUIElementPerformAction(found, kAXPressAction as CFString)
            return result == .success ? ["status": "clicked"] : ["error": "Could not press element"]
        }

        return ["error": "Element not found with role=\(targetRole), title=\(targetTitle ?? "nil"), description=\(targetDesc ?? "nil")"]
    }

    private static func findElement(_ element: AXUIElement, role: String, title: String?, description: String?, maxDepth: Int, depth: Int = 0) -> AXUIElement? {
        guard depth < maxDepth else { return nil }

        var roleRef: CFTypeRef?
        var titleRef: CFTypeRef?
        var descRef: CFTypeRef?

        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &titleRef)
        AXUIElementCopyAttributeValue(element, kAXDescriptionAttribute as CFString, &descRef)

        let elRole = roleRef as? String ?? ""
        let elTitle = titleRef as? String ?? ""
        let elDesc = descRef as? String ?? ""

        if elRole == role {
            if let t = title, elTitle.lowercased().contains(t.lowercased()) { return element }
            if let d = description, elDesc.lowercased().contains(d.lowercased()) { return element }
            if title == nil && description == nil { return element }
        }

        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            for child in children {
                if let found = findElement(child, role: role, title: title, description: description, maxDepth: maxDepth, depth: depth + 1) {
                    return found
                }
            }
        }
        return nil
    }

    // MARK: - Set value on a UI element (text fields)

    static func setUIValue(params: [String: Any]) async -> Any {
        guard await ensurePermission() else {
            return ["error": "Accessibility permission not granted"]
        }

        guard let appName = params["app"] as? String,
              let value = params["value"] as? String else {
            return ["error": "app and value required"]
        }
        let targetTitle = params["title"] as? String
        let targetRole = params["role"] as? String ?? "AXTextField"

        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName?.lowercased() == appName.lowercased()
        }) else {
            return ["error": "App not running: \(appName)"]
        }

        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        var windowRef: CFTypeRef?
        AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef)
        let root = windowRef != nil ? (windowRef as! AXUIElement) : appElement

        if let found = findElement(root, role: targetRole, title: targetTitle, description: nil, maxDepth: 8) {
            let result = AXUIElementSetAttributeValue(found, kAXValueAttribute as CFString, value as CFTypeRef)
            return result == .success ? ["status": "value_set"] : ["error": "Could not set value"]
        }

        return ["error": "Element not found"]
    }
}
