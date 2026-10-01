import Foundation
import AppKit
import ApplicationServices

enum BrowserBridge {

    // MARK: - Browser selection

    /// Safari and Chrome both speak AppleScript but with different vocabularies,
    /// so every command below builds its script per browser. Defaulting to Safari
    /// keeps existing callers working.
    private static func isChrome(_ params: [String: Any]) -> Bool {
        let b = (params["browser"] as? String)?.lowercased() ?? "safari"
        return b == "chrome" || b == "google chrome"
    }

    private static func appName(_ params: [String: Any]) -> String {
        isChrome(params) ? "Google Chrome" : "Safari"
    }

    /// Chrome refuses AppleScript JavaScript unless the user has ticked a hidden
    /// Develop-menu option. Asking them to go and find it is not an acceptable
    /// experience, so this is treated as a routing signal rather than an error:
    /// the caller falls back to the Accessibility API, which needs no per-app
    /// setting and uses the permission Bridge onboarding already granted.
    private static func isAppleEventsBlocked(_ error: String) -> Bool {
        let lowered = error.lowercased()
        return lowered.contains("not allowed")
            || lowered.contains("-1743")
            || lowered.contains("privilege")
            || lowered.contains("not authorized")
    }

    private static func run(_ script: String) -> (value: String?, error: String?) {
        guard let appleScript = NSAppleScript(source: script) else {
            return (nil, "Failed to create AppleScript")
        }
        var errorInfo: NSDictionary?
        let result = appleScript.executeAndReturnError(&errorInfo)
        if let error = errorInfo {
            return (nil, error["NSAppleScriptErrorMessage"] as? String ?? "AppleScript failed")
        }
        return (result.stringValue ?? "", nil)
    }

    // MARK: - Accessibility fallback for Chrome

    /// Walk Chrome's accessibility tree and collect the readable text of the page.
    /// Web content sits deep in the tree, so this goes much further down than the
    /// generic UI reader and collects text rather than element descriptions.
    private static func axPageText(maxLength: Int) -> String? {
        guard AXIsProcessTrusted() else { return nil }
        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            $0.bundleIdentifier == "com.google.Chrome"
        }) else { return nil }

        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        var windowRef: CFTypeRef?
        AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef)
        guard let window = windowRef else { return nil }

        var pieces: [String] = []
        var budget = maxLength
        collectText(window as! AXUIElement, depth: 0, maxDepth: 40, pieces: &pieces, budget: &budget)
        guard !pieces.isEmpty else { return nil }
        return pieces.joined(separator: "\n")
    }

    private static func collectText(_ element: AXUIElement, depth: Int, maxDepth: Int, pieces: inout [String], budget: inout Int) {
        guard depth < maxDepth, budget > 0 else { return }

        var roleRef: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &roleRef)
        let role = roleRef as? String ?? ""

        // Text lives in value on static text and text fields, in title on controls.
        for attr in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
            var ref: CFTypeRef?
            AXUIElementCopyAttributeValue(element, attr as CFString, &ref)
            if let text = ref as? String, !text.isEmpty, text.count < 5000 {
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty && !pieces.contains(trimmed) {
                    pieces.append(trimmed)
                    budget -= trimmed.count
                }
                break
            }
        }
        // Menus and toolbars are chrome, not page content
        if ["AXMenuBar", "AXMenu", "AXMenuItem"].contains(role) { return }

        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            for child in children {
                collectText(child, depth: depth + 1, maxDepth: maxDepth, pieces: &pieces, budget: &budget)
            }
        }
    }

    /// What to tell the model when Chrome cannot run scripts and there is no
    /// direct equivalent. The remedy is for the bot to route around it, never
    /// for the user to go and change a browser setting.
    private static let chromeScriptingUnavailable =
        "Chrome cannot run page scripts on this Mac. Do not ask the user to change any browser setting. "
        + "Use bridge_ax_read_ui / bridge_ax_click with app \"Google Chrome\" instead, or if the page is "
        + "also open in Safari use browser: \"safari\"."

    /// The one script fragment every command needs: run JS in the frontmost tab.
    private static func jsScript(_ escapedJS: String, chrome: Bool) -> String {
        if chrome {
            return """
            tell application "Google Chrome"
                if (count of windows) = 0 then return "NO_WINDOW"
                set jsResult to execute active tab of front window javascript "\(escapedJS)"
                return jsResult as text
            end tell
            """
        }
        return """
        tell application "Safari"
            if (count of windows) = 0 then return "NO_WINDOW"
            set jsResult to do JavaScript "\(escapedJS)" in current tab of front window
            return jsResult as text
        end tell
        """
    }

    // MARK: - Get active tab info

    static func activeTab(params: [String: Any]) async -> Any {
        let chrome = isChrome(params)

        let script: String
        if chrome {
            script = """
            tell application "Google Chrome"
                if (count of windows) = 0 then return "NO_WINDOW"
                set tabTitle to title of active tab of front window
                set tabURL to URL of active tab of front window
                return tabURL & "|||" & tabTitle
            end tell
            """
        } else {
            script = """
            tell application "Safari"
                if (count of windows) = 0 then return "NO_WINDOW"
                set tabURL to URL of current tab of front window
                set tabTitle to name of current tab of front window
                return tabURL & "|||" & tabTitle
            end tell
            """
        }

        let (value, error) = run(script)
        if let error = error { return ["error": error] }
        let str = value ?? ""
        if str == "NO_WINDOW" {
            return ["error": "No \(appName(params)) window open"]
        }
        let parts = str.components(separatedBy: "|||")
        return [
            "url": parts.first ?? "",
            "title": parts.count > 1 ? parts[1] : "",
            "browser": appName(params)
        ]
    }

    // MARK: - Open URL

    static func openURL(params: [String: Any]) async -> Any {
        guard let urlString = params["url"] as? String,
              let url = URL(string: urlString) else {
            return ["error": "Valid url required"]
        }

        // Block dangerous schemes
        let scheme = url.scheme?.lowercased() ?? ""
        guard ["http", "https"].contains(scheme) else {
            return ["error": "Only http/https URLs allowed"]
        }

        let browser = (params["browser"] as? String)?.lowercased()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        if let browser = browser, browser == "chrome" || browser == "google chrome" {
            process.arguments = ["-a", "Google Chrome", urlString]
        } else if let browser = browser, browser == "safari" {
            process.arguments = ["-a", "Safari", urlString]
        } else {
            process.arguments = [urlString] // default browser
        }

        do {
            try process.run()
            process.waitUntilExit()
            return ["status": "opened", "url": urlString]
        } catch {
            return ["error": "Failed to open URL: \(error.localizedDescription)"]
        }
    }

    // MARK: - Get page content

    static func pageContent(params: [String: Any]) async -> Any {
        let chrome = isChrome(params)
        let maxLength = 50000
        let js = "document.body.innerText.substring(0, \(maxLength))"

        let (value, error) = run(jsScript(js, chrome: chrome))

        // Chrome with scripting disabled still has a readable accessibility tree,
        // so fall through to it rather than surfacing a failure.
        if chrome, error != nil || (value ?? "").isEmpty {
            if let axText = axPageText(maxLength: maxLength) {
                return [
                    "content": axText,
                    "length": axText.count,
                    "truncated": axText.count >= maxLength,
                    "method": "accessibility"
                ]
            }
        }

        if let error = error { return ["error": error] }
        let content = value ?? ""
        if content == "NO_WINDOW" {
            return ["error": "No \(appName(params)) window open"]
        }
        return [
            "content": content,
            "length": content.count,
            "truncated": content.count >= maxLength
        ]
    }

    // MARK: - List open tabs

    static func listTabs(params: [String: Any]) async -> Any {
        let chrome = isChrome(params)

        let script: String
        if chrome {
            script = """
            tell application "Google Chrome"
                set tabList to {}
                repeat with w in windows
                    repeat with t in tabs of w
                        set end of tabList to (URL of t) & "|||" & (title of t)
                    end repeat
                end repeat
                set AppleScript's text item delimiters to "\\n"
                return tabList as text
            end tell
            """
        } else {
            script = """
            tell application "Safari"
                set tabList to {}
                repeat with w in windows
                    repeat with t in tabs of w
                        set end of tabList to (URL of t) & "|||" & (name of t)
                    end repeat
                end repeat
                set AppleScript's text item delimiters to "\\n"
                return tabList as text
            end tell
            """
        }

        let (value, error) = run(script)
        if let error = error { return ["error": error] }

        let lines = (value ?? "").components(separatedBy: "\n").filter { !$0.isEmpty }
        let tabs = lines.prefix(50).map { line -> [String: String] in
            let parts = line.components(separatedBy: "|||")
            return ["url": parts.first ?? "", "title": parts.count > 1 ? parts[1] : ""]
        }

        return ["tabs": tabs, "count": tabs.count, "browser": appName(params)]
    }

    // MARK: - Execute JavaScript in the active tab

    static func executeJS(params: [String: Any]) async -> Any {
        guard let js = params["javascript"] as? String else {
            return ["error": "javascript code required"]
        }

        // Safety: cap JS length
        guard js.count < 50000 else {
            return ["error": "JavaScript too long (max 50KB)"]
        }

        let chrome = isChrome(params)
        let escaped = js.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")

        let (value, error) = run(jsScript(escaped, chrome: chrome))
        if let error = error {
            if chrome && isAppleEventsBlocked(error) {
                return ["error": chromeScriptingUnavailable]
            }
            return ["error": error]
        }
        let output = value ?? ""
        if output == "NO_WINDOW" {
            return ["error": "No \(appName(params)) window open"]
        }
        // Truncate large results
        let maxLen = 50000
        return [
            "result": output.count > maxLen ? String(output.prefix(maxLen)) : output,
            "truncated": output.count > maxLen
        ]
    }

    // MARK: - Click element by CSS selector

    static func clickElement(params: [String: Any]) async -> Any {
        guard let selector = params["selector"] as? String else {
            return ["error": "CSS selector required"]
        }
        let escaped = selector.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "'", with: "\\'")

        let js = "document.querySelector('\(escaped)')?.click(); 'clicked'"
        return await executeJS(params: ["javascript": js, "browser": params["browser"] ?? "safari"])
    }

    // MARK: - Type text into focused element or by selector

    static func typeText(params: [String: Any]) async -> Any {
        guard let text = params["text"] as? String else {
            return ["error": "text required"]
        }
        let selector = params["selector"] as? String
        let escapedText = text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")

        var js: String
        if let sel = selector {
            let escapedSel = sel.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            js = """
            var el = document.querySelector('\(escapedSel)');
            if (el) { el.focus(); el.value = '\(escapedText)'; el.dispatchEvent(new Event('input', {bubbles:true})); 'typed'; }
            else { 'element not found'; }
            """
        } else {
            js = """
            var el = document.activeElement;
            if (el) { el.value = '\(escapedText)'; el.dispatchEvent(new Event('input', {bubbles:true})); 'typed'; }
            else { 'no active element'; }
            """
        }
        return await executeJS(params: ["javascript": js, "browser": params["browser"] ?? "safari"])
    }

    // MARK: - Switch to tab by index

    static func switchTab(params: [String: Any]) async -> Any {
        guard let index = params["index"] as? Int else {
            return ["error": "tab index required (1-based)"]
        }
        let chrome = isChrome(params)

        let script: String
        if chrome {
            script = """
            tell application "Google Chrome"
                if (count of windows) = 0 then return "NO_WINDOW"
                set active tab index of front window to \(index)
                return "switched to tab \(index)"
            end tell
            """
        } else {
            script = """
            tell application "Safari"
                if (count of windows) = 0 then return "NO_WINDOW"
                set current tab of front window to tab \(index) of front window
                return "switched to tab \(index)"
            end tell
            """
        }

        let (value, error) = run(script)
        if let error = error { return ["error": error] }
        if value == "NO_WINDOW" {
            return ["error": "No \(appName(params)) window open"]
        }
        return ["status": value ?? "switched"]
    }

    // MARK: - Close current tab

    static func closeTab(params: [String: Any]) async -> Any {
        let chrome = isChrome(params)

        let script: String
        if chrome {
            script = """
            tell application "Google Chrome"
                if (count of windows) = 0 then return "NO_WINDOW"
                close active tab of front window
                return "closed"
            end tell
            """
        } else {
            script = """
            tell application "Safari"
                if (count of windows) = 0 then return "NO_WINDOW"
                close current tab of front window
                return "closed"
            end tell
            """
        }

        let (value, error) = run(script)
        if let error = error { return ["error": error] }
        if value == "NO_WINDOW" {
            return ["error": "No \(appName(params)) window open"]
        }
        return ["status": "closed"]
    }

    // MARK: - Navigate current tab to URL

    static func navigate(params: [String: Any]) async -> Any {
        guard let urlString = params["url"] as? String else {
            return ["error": "url required"]
        }
        guard let url = URL(string: urlString), ["http", "https"].contains(url.scheme?.lowercased()) else {
            return ["error": "Only http/https URLs allowed"]
        }
        let chrome = isChrome(params)
        let escaped = urlString.replacingOccurrences(of: "\"", with: "\\\"")

        let script: String
        if chrome {
            script = """
            tell application "Google Chrome"
                if (count of windows) = 0 then make new window
                set URL of active tab of front window to "\(escaped)"
                return "navigated"
            end tell
            """
        } else {
            script = """
            tell application "Safari"
                if (count of windows) = 0 then make new document
                set URL of current tab of front window to "\(escaped)"
                return "navigated"
            end tell
            """
        }

        let (_, error) = run(script)
        if let error = error { return ["error": error] }
        return ["status": "navigated", "url": urlString]
    }
}
