import Foundation
import AppKit
import CoreGraphics

/// Raw mouse and keyboard control via CGEvents.
/// This is the "last resort" layer — visible to the user (mouse moves, keys appear).
/// Prefer AppleScript or Accessibility API when possible.
enum InputBridge {

    // MARK: - Mouse

    static func mouseMove(params: [String: Any]) async -> Any {
        guard let x = params["x"] as? Double ?? (params["x"] as? Int).map(Double.init),
              let y = params["y"] as? Double ?? (params["y"] as? Int).map(Double.init) else {
            return ["error": "x and y coordinates required"]
        }

        let point = CGPoint(x: x, y: y)
        let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
        event?.post(tap: .cghidEventTap)

        return ["status": "moved", "x": Int(x), "y": Int(y)]
    }

    static func mouseClick(params: [String: Any]) async -> Any {
        guard let x = params["x"] as? Double ?? (params["x"] as? Int).map(Double.init),
              let y = params["y"] as? Double ?? (params["y"] as? Int).map(Double.init) else {
            return ["error": "x and y coordinates required"]
        }

        let point = CGPoint(x: x, y: y)
        let button: CGMouseButton = (params["button"] as? String) == "right" ? .right : .left
        let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
        let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp

        let clickCount = params["clicks"] as? Int ?? 1

        for _ in 0..<clickCount {
            let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button)
            let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
            down?.post(tap: .cghidEventTap)
            usleep(50_000) // 50ms
            up?.post(tap: .cghidEventTap)
            usleep(50_000)
        }

        return ["status": "clicked", "x": Int(x), "y": Int(y), "clicks": clickCount]
    }

    static func mouseDrag(params: [String: Any]) async -> Any {
        guard let fromX = params["from_x"] as? Double ?? (params["from_x"] as? Int).map(Double.init),
              let fromY = params["from_y"] as? Double ?? (params["from_y"] as? Int).map(Double.init),
              let toX = params["to_x"] as? Double ?? (params["to_x"] as? Int).map(Double.init),
              let toY = params["to_y"] as? Double ?? (params["to_y"] as? Int).map(Double.init) else {
            return ["error": "from_x, from_y, to_x, to_y required"]
        }

        let from = CGPoint(x: fromX, y: fromY)
        let to = CGPoint(x: toX, y: toY)

        let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)
        down?.post(tap: .cghidEventTap)
        usleep(100_000)

        // Interpolate for smooth drag
        let steps = 10
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let x = fromX + (toX - fromX) * t
            let y = fromY + (toY - fromY) * t
            let drag = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)
            drag?.post(tap: .cghidEventTap)
            usleep(20_000)
        }

        let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)
        up?.post(tap: .cghidEventTap)

        return ["status": "dragged", "from": [Int(fromX), Int(fromY)], "to": [Int(toX), Int(toY)]]
    }

    // MARK: - Keyboard

    static func keyType(params: [String: Any]) async -> Any {
        guard let text = params["text"] as? String else {
            return ["error": "text required"]
        }

        for char in text {
            let str = String(char)
            let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
            let chars = Array(str.utf16)
            event?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
            event?.post(tap: .cghidEventTap)

            let upEvent = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            upEvent?.post(tap: .cghidEventTap)
            usleep(20_000)
        }

        return ["status": "typed", "length": text.count]
    }

    static func keyPress(params: [String: Any]) async -> Any {
        guard let key = params["key"] as? String else {
            return ["error": "key required (e.g. 'return', 'tab', 'escape', 'space', 'delete', 'up', 'down', 'left', 'right')"]
        }

        let modifiers = params["modifiers"] as? [String] ?? []

        guard let keyCode = keyCodeFor(key) else {
            return ["error": "Unknown key: \(key). Supported: return, tab, escape, space, delete, up, down, left, right, f1-f12, a-z, 0-9"]
        }

        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod.lowercased() {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }

        let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
        if !flags.isEmpty {
            down?.flags = flags
            up?.flags = flags
        }
        down?.post(tap: .cghidEventTap)
        usleep(50_000)
        up?.post(tap: .cghidEventTap)

        return ["status": "pressed", "key": key, "modifiers": modifiers]
    }

    static func keyCombo(params: [String: Any]) async -> Any {
        // Shortcut for common combos like cmd+c, cmd+v, cmd+a
        guard let combo = params["combo"] as? String else {
            return ["error": "combo required (e.g. 'cmd+c', 'cmd+shift+a')"]
        }

        let parts = combo.lowercased().split(separator: "+").map(String.init)
        guard let key = parts.last else {
            return ["error": "Invalid combo format"]
        }

        let modifiers = Array(parts.dropLast())
        return await keyPress(params: ["key": key, "modifiers": modifiers])
    }

    // MARK: - Scroll

    static func scroll(params: [String: Any]) async -> Any {
        let dx = params["dx"] as? Int ?? 0
        let dy = params["dy"] as? Int ?? (params["amount"] as? Int ?? -3)

        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0)
        event?.post(tap: .cgSessionEventTap)

        return ["status": "scrolled", "dx": dx, "dy": dy]
    }

    // MARK: - Key code mapping

    private static func keyCodeFor(_ key: String) -> CGKeyCode? {
        switch key.lowercased() {
        case "return", "enter": return 36
        case "tab": return 48
        case "space": return 49
        case "delete", "backspace": return 51
        case "escape", "esc": return 53
        case "up": return 126
        case "down": return 125
        case "left": return 123
        case "right": return 124
        case "home": return 115
        case "end": return 119
        case "pageup": return 116
        case "pagedown": return 121
        case "f1": return 122
        case "f2": return 120
        case "f3": return 99
        case "f4": return 118
        case "f5": return 96
        case "f6": return 97
        case "f7": return 98
        case "f8": return 100
        case "f9": return 101
        case "f10": return 109
        case "f11": return 103
        case "f12": return 111
        case "a": return 0
        case "b": return 11
        case "c": return 8
        case "d": return 2
        case "e": return 14
        case "f": return 3
        case "g": return 5
        case "h": return 4
        case "i": return 34
        case "j": return 38
        case "k": return 40
        case "l": return 37
        case "m": return 46
        case "n": return 45
        case "o": return 31
        case "p": return 35
        case "q": return 12
        case "r": return 15
        case "s": return 1
        case "t": return 17
        case "u": return 32
        case "v": return 9
        case "w": return 13
        case "x": return 7
        case "y": return 16
        case "z": return 6
        case "0": return 29
        case "1": return 18
        case "2": return 19
        case "3": return 20
        case "4": return 21
        case "5": return 23
        case "6": return 22
        case "7": return 26
        case "8": return 28
        case "9": return 25
        default: return nil
        }
    }
}
