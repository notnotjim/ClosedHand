import Foundation
import IOKit.ps
import AppKit
import CoreGraphics

enum SystemBridge {

    // MARK: - Keep Awake (caffeinate)

    private static var caffeinateProcess: Process?

    static func keepAwake(params: [String: Any]) async -> Any {
        let enable = params["enable"] as? Bool ?? true

        if enable {
            if caffeinateProcess != nil {
                return ["status": "already_awake"]
            }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/caffeinate")
            process.arguments = ["-di"] // prevent display sleep + idle sleep
            do {
                try process.run()
                caffeinateProcess = process
                return ["status": "awake", "message": "Computer will stay awake while Bridge is running"]
            } catch {
                return ["error": "Failed to start caffeinate: \(error.localizedDescription)"]
            }
        } else {
            caffeinateProcess?.terminate()
            caffeinateProcess = nil
            return ["status": "normal", "message": "Computer can sleep normally"]
        }
    }

    static func stopCaffeinate() {
        caffeinateProcess?.terminate()
        caffeinateProcess = nil
    }

    // MARK: - System Info

    static func info(params: [String: Any]) async -> Any {
        var result: [String: Any] = [:]

        // Battery
        if let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
           let sources = IOPSCopyPowerSourcesList(snapshot)?.takeRetainedValue() as? [Any],
           let first = sources.first,
           let desc = IOPSGetPowerSourceDescription(snapshot, first as CFTypeRef)?.takeUnretainedValue() as? [String: Any] {
            result["battery_percent"] = desc[kIOPSCurrentCapacityKey] as? Int
            result["battery_charging"] = (desc[kIOPSPowerSourceStateKey] as? String) == kIOPSACPowerValue
        }

        // Disk space
        if let attrs = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory()) {
            let free = attrs[.systemFreeSize] as? Int64 ?? 0
            let total = attrs[.systemSize] as? Int64 ?? 0
            result["disk_free_gb"] = Double(free) / 1_073_741_824.0
            result["disk_total_gb"] = Double(total) / 1_073_741_824.0
        }

        // Hostname and user
        result["hostname"] = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        result["username"] = NSUserName()
        result["os_version"] = ProcessInfo.processInfo.operatingSystemVersionString

        // Uptime
        result["uptime_hours"] = ProcessInfo.processInfo.systemUptime / 3600.0

        return result
    }

    // MARK: - Screenshot

    static func screenshot(params: [String: Any]) async -> Any {
        // Use CGWindowListCreateImage directly (uses the app's own screen recording permission)
        guard let cgImage = CGWindowListCreateImage(
            CGRect.null, // null = entire display
            .optionOnScreenOnly,
            kCGNullWindowID,
            [.bestResolution, .boundsIgnoreFraming]
        ) else {
            // Auto-open Screen Recording settings and wait for permission
            print("[SystemBridge] Screenshot failed, opening Screen Recording settings...")
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
                NSWorkspace.shared.open(url)
            }
            // Poll for up to 30s
            for _ in 1...15 {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if let retryImage = CGWindowListCreateImage(CGRect.null, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution, .boundsIgnoreFraming]) {
                    // Permission granted, continue with retry image
                    let retryRep = NSBitmapImageRep(cgImage: retryImage)
                    let maxDim: CGFloat = 1920
                    let scale = min(1.0, maxDim / max(CGFloat(retryImage.width), CGFloat(retryImage.height)))
                    guard let retryData = retryRep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
                        return ["error": "Failed to encode screenshot"]
                    }
                    if retryData.count > 5_000_000 {
                        return ["error": "Screenshot too large (\(retryData.count / 1024)KB)"]
                    }
                    return ["base64": retryData.base64EncodedString(), "width": Int(CGFloat(retryImage.width) * scale), "height": Int(CGFloat(retryImage.height) * scale), "format": "jpeg"]
                }
            }
            return ["error": "Screen Recording permission was not granted within 30 seconds."]
        }

        let bitmapRep = NSBitmapImageRep(cgImage: cgImage)

        // Scale down if needed to stay under size limit
        let maxDim: CGFloat = 1920
        let scale = min(1.0, maxDim / max(CGFloat(cgImage.width), CGFloat(cgImage.height)))
        let newWidth = Int(CGFloat(cgImage.width) * scale)
        let newHeight = Int(CGFloat(cgImage.height) * scale)

        let resized = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: newWidth, pixelsHigh: newHeight, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: resized)
        bitmapRep.draw(in: NSRect(x: 0, y: 0, width: newWidth, height: newHeight))
        NSGraphicsContext.restoreGraphicsState()

        guard let jpegData = resized.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else {
            return ["error": "Failed to encode screenshot"]
        }

        if jpegData.count > 2_000_000 {
            // Try lower quality
            guard let smallerData = resized.representation(using: .jpeg, properties: [.compressionFactor: 0.4]) else {
                return ["error": "Screenshot too large"]
            }
            return [
                "base64": smallerData.base64EncodedString(),
                "size": smallerData.count,
                "format": "jpeg"
            ]
        }

        // Include screen dimensions so the bot can map image pixels to real screen coordinates
        let screen = NSScreen.main ?? NSScreen.screens[0]
        let screenFrame = screen.frame
        let backingScale = screen.backingScaleFactor

        return [
            "base64": jpegData.base64EncodedString(),
            "size": jpegData.count,
            "format": "jpeg",
            "screen_width": Int(screenFrame.width),
            "screen_height": Int(screenFrame.height),
            "image_width": newWidth,
            "image_height": newHeight,
            "backing_scale": backingScale,
            "note": "To click at a position visible in this image: multiply image x/y by (screen_width/image_width) and (screen_height/image_height) to get real screen coordinates for input.mouse_click."
        ]
    }

    // MARK: - App Launch

    static func launchApp(params: [String: Any]) async -> Any {
        guard let appName = params["app"] as? String else {
            return ["error": "app name required"]
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-a", appName]

        do {
            try process.run()
            process.waitUntilExit()
            if process.terminationStatus == 0 {
                return ["status": "launched", "app": appName]
            } else {
                return ["error": "Could not find app: \(appName)"]
            }
        } catch {
            return ["error": "Failed to launch: \(error.localizedDescription)"]
        }
    }

    // MARK: - Clipboard

    static func clipboardRead(params: [String: Any]) async -> Any {
        let script = """
        tell application "System Events"
            set clipContent to the clipboard
            return clipContent
        end tell
        """
        guard let appleScript = NSAppleScript(source: script) else {
            return ["error": "Failed to create AppleScript"]
        }
        var errorInfo: NSDictionary?
        let result = appleScript.executeAndReturnError(&errorInfo)
        if let error = errorInfo {
            return ["error": error["NSAppleScriptErrorMessage"] as? String ?? "Clipboard read failed"]
        }
        return ["content": result.stringValue ?? ""]
    }

    static func clipboardWrite(params: [String: Any]) async -> Any {
        guard let text = params["text"] as? String else {
            return ["error": "text required"]
        }
        let escaped = text.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let script = """
        set the clipboard to "\(escaped)"
        """
        guard let appleScript = NSAppleScript(source: script) else {
            return ["error": "Failed to create AppleScript"]
        }
        var errorInfo: NSDictionary?
        appleScript.executeAndReturnError(&errorInfo)
        if let error = errorInfo {
            return ["error": error["NSAppleScriptErrorMessage"] as? String ?? "Clipboard write failed"]
        }
        return ["status": "written"]
    }
}
