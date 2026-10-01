import Foundation

/// Run AppleScript synchronously (call from background thread or wrap in Task.detached)
func runAppleScript(_ source: String) -> Any? {
    let script = NSAppleScript(source: source)
    var error: NSDictionary?
    let result = script?.executeAndReturnError(&error)

    if let error {
        print("AppleScript error: \(error)")
        return nil
    }

    return parseAppleScriptResult(result)
}

/// Run AppleScript off the main thread with a timeout to avoid blocking WebSocket message handling
func runAppleScriptAsync(_ source: String, timeout: TimeInterval = 20) async -> Any? {
    await withCheckedContinuation { continuation in
        var resumed = false
        let lock = NSLock()

        // Timeout: return nil if AppleScript takes too long
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            lock.lock()
            if !resumed {
                resumed = true
                lock.unlock()
                print("AppleScript timed out after \(Int(timeout))s")
                continuation.resume(returning: nil)
            } else {
                lock.unlock()
            }
        }

        // Execute AppleScript on background thread
        DispatchQueue.global(qos: .userInitiated).async {
            let result = runAppleScript(source)
            lock.lock()
            if !resumed {
                resumed = true
                lock.unlock()
                continuation.resume(returning: result)
            } else {
                lock.unlock()
            }
        }
    }
}

private func parseAppleScriptResult(_ descriptor: NSAppleEventDescriptor?) -> Any? {
    guard let descriptor else { return nil }

    switch descriptor.descriptorType {
    case typeAEList:
        var array: [Any] = []
        guard descriptor.numberOfItems > 0 else { return array }
        for i in 1...descriptor.numberOfItems {
            if let item = parseAppleScriptResult(descriptor.atIndex(i)) {
                array.append(item)
            }
        }
        return array
    case typeAERecord:
        var dict: [String: Any] = [:]
        guard descriptor.numberOfItems > 0 else { return dict }
        for i in 1...descriptor.numberOfItems {
            let key = descriptor.keywordForDescriptor(at: i)
            let keyStr = String(format: "%c%c%c%c",
                               (key >> 24) & 0xFF, (key >> 16) & 0xFF,
                               (key >> 8) & 0xFF, key & 0xFF)
            if let value = parseAppleScriptResult(descriptor.atIndex(i)) {
                dict[keyStr] = value
            }
        }
        return dict
    case typeUnicodeText, typeUTF8Text:
        return descriptor.stringValue
    case typeSInt32, typeSInt64:
        return descriptor.int32Value
    case typeTrue:
        return true
    case typeFalse:
        return false
    default:
        return descriptor.stringValue
    }
}
