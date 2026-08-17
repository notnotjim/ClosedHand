import Foundation
#if canImport(AppKit)
import AppKit
#endif

enum FileBridge {
    private static let fm = FileManager.default
    private static let maxFileSize = 50 * 1024 // 50KB
    private static let maxListItems = 50
    private static let maxSearchResults = 20

    /// Validate that a path is within the user's home directory (resolving symlinks)
    private static func validatePath(_ path: String) -> (valid: Bool, resolved: String, error: String?) {
        let expanded = NSString(string: path).expandingTildeInPath
        let resolved = (expanded as NSString).resolvingSymlinksInPath
        let home = NSHomeDirectory()
        guard resolved.hasPrefix(home + "/") || resolved == home else {
            return (false, resolved, "Access denied: path must be within your home directory")
        }
        return (true, resolved, nil)
    }

    static func listFiles(params: [String: Any]) async -> Any {
        let path = params["path"] as? String ?? "~/Desktop"
        let check = validatePath(path)
        guard check.valid else { return ["error": check.error!] }

        let dirPath = check.resolved
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: dirPath, isDirectory: &isDir), isDir.boolValue else {
            return ["error": "Not a directory: \(path)"]
        }

        do {
            let contents = try fm.contentsOfDirectory(atPath: dirPath)
            let formatter = ISO8601DateFormatter()
            var items: [[String: Any]] = []

            for name in contents.prefix(maxListItems) {
                let fullPath = (dirPath as NSString).appendingPathComponent(name)
                var itemIsDir: ObjCBool = false
                fm.fileExists(atPath: fullPath, isDirectory: &itemIsDir)

                var item: [String: Any] = [
                    "name": name,
                    "type": itemIsDir.boolValue ? "directory" : "file",
                ]

                if let attrs = try? fm.attributesOfItem(atPath: fullPath) {
                    item["size"] = attrs[.size] as? Int ?? 0
                    if let modified = attrs[.modificationDate] as? Date {
                        item["modified"] = formatter.string(from: modified)
                    }
                }

                items.append(item)
            }

            return ["path": dirPath, "count": items.count, "items": items]
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    static func readFile(params: [String: Any]) async -> Any {
        guard let path = params["path"] as? String else { return ["error": "path required"] }
        let check = validatePath(path)
        guard check.valid else { return ["error": check.error!] }

        let filePath = check.resolved
        guard fm.fileExists(atPath: filePath) else {
            return ["error": "File not found: \(path)"]
        }

        let offset = params["offset"] as? Int ?? 0
        let limit = params["limit"] as? Int ?? 0

        do {
            let attrs = try fm.attributesOfItem(atPath: filePath)
            let size = attrs[.size] as? Int ?? 0

            let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
            guard let content = String(data: data, encoding: .utf8) else {
                return ["error": "File is not a text file or uses unsupported encoding"]
            }

            let lines = content.components(separatedBy: "\n")
            let totalLines = lines.count

            // Apply offset and limit if specified
            if offset > 0 || limit > 0 {
                let startLine = min(offset, totalLines)
                let endLine = limit > 0 ? min(startLine + limit, totalLines) : totalLines
                let selectedLines = Array(lines[startLine..<endLine])

                // Format with line numbers
                let numbered = selectedLines.enumerated().map { (i, line) in
                    "\(startLine + i + 1)\t\(line)"
                }.joined(separator: "\n")

                return ["path": filePath, "size": size, "total_lines": totalLines, "from_line": startLine + 1, "to_line": endLine, "content": numbered]
            }

            // Full file with line numbers (cap at 200KB)
            if size > 200 * 1024 {
                return ["error": "File too large (\(size) bytes). Use offset and limit to read a portion."]
            }

            let numbered = lines.enumerated().map { (i, line) in
                "\(i + 1)\t\(line)"
            }.joined(separator: "\n")

            return ["path": filePath, "size": size, "total_lines": totalLines, "content": numbered]
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    /// Precise string replacement in a file (like Claude Code's Edit tool)
    static func editFile(params: [String: Any]) async -> Any {
        guard let path = params["path"] as? String,
              let oldString = params["old_string"] as? String,
              let newString = params["new_string"] as? String else {
            return ["error": "path, old_string, and new_string required"]
        }
        let replaceAll = params["replace_all"] as? Bool ?? false

        let check = validatePath(path)
        guard check.valid else { return ["error": check.error!] }

        let filePath = check.resolved
        guard fm.fileExists(atPath: filePath) else {
            return ["error": "File not found: \(path)"]
        }

        do {
            var content = try String(contentsOfFile: filePath, encoding: .utf8)

            if replaceAll {
                let count = content.components(separatedBy: oldString).count - 1
                if count == 0 {
                    return ["error": "old_string not found in file"]
                }
                content = content.replacingOccurrences(of: oldString, with: newString)
                try content.write(toFile: filePath, atomically: true, encoding: .utf8)
                return ["success": true, "path": filePath, "replacements": count]
            } else {
                guard let range = content.range(of: oldString) else {
                    return ["error": "old_string not found in file"]
                }
                // Check uniqueness
                let afterFirst = content[range.upperBound...]
                if afterFirst.range(of: oldString) != nil {
                    return ["error": "old_string is not unique in the file. Provide more context or use replace_all."]
                }
                content.replaceSubrange(range, with: newString)
                try content.write(toFile: filePath, atomically: true, encoding: .utf8)
                return ["success": true, "path": filePath, "replacements": 1]
            }
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    /// Search file contents with regex (like Claude Code's Grep tool)
    static func grepFiles(params: [String: Any]) async -> Any {
        guard let pattern = params["pattern"] as? String else { return ["error": "pattern required"] }
        let searchPath = params["path"] as? String ?? "."
        let glob = params["glob"] as? String
        let context = params["context"] as? Int ?? 0
        let maxResults = params["max_results"] as? Int ?? 50

        // Use ripgrep if available, fall back to grep
        let process = Process()
        let rgPath = "/opt/homebrew/bin/rg"
        let useRg = fm.fileExists(atPath: rgPath)

        if useRg {
            process.executableURL = URL(fileURLWithPath: rgPath)
            var args = ["-n", "--max-count", "100"]
            if context > 0 { args += ["-C", String(context)] }
            if let glob = glob { args += ["--glob", glob] }
            args += [pattern, searchPath]
            process.arguments = args
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/grep")
            var args = ["-rn", "--max-count=100"]
            if context > 0 { args += ["-C", String(context)] }
            if let glob = glob { args += ["--include", glob] }
            args += [pattern, searchPath]
            process.arguments = args
        }

        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""

            let lines = output.components(separatedBy: "\n").filter { !$0.isEmpty }
            let truncated = Array(lines.prefix(maxResults))

            return ["pattern": pattern, "matches": truncated.count, "results": truncated.joined(separator: "\n")]
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    /// Find files by glob pattern (like Claude Code's Glob tool)
    static func globFiles(params: [String: Any]) async -> Any {
        guard let pattern = params["pattern"] as? String else { return ["error": "pattern required"] }
        let searchPath = params["path"] as? String ?? "."

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/find")

        // Convert glob pattern to find -name pattern
        process.arguments = [searchPath, "-name", pattern, "-maxdepth", "10", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"]
        process.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            let files = output.components(separatedBy: "\n").filter { !$0.isEmpty }.prefix(100)

            return ["pattern": pattern, "count": files.count, "files": Array(files)]
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    static func writeFile(params: [String: Any]) async -> Any {
        guard let path = params["path"] as? String,
              let content = params["content"] as? String else {
            return ["error": "path and content required"]
        }
        let check = validatePath(path)
        guard check.valid else { return ["error": check.error!] }

        let filePath = check.resolved

        do {
            try content.write(toFile: filePath, atomically: true, encoding: .utf8)
            return ["success": true, "path": filePath, "size": content.utf8.count]
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    static func moveFile(params: [String: Any]) async -> Any {
        guard let from = params["from"] as? String,
              let to = params["to"] as? String else {
            return ["error": "from and to required"]
        }
        let checkFrom = validatePath(from)
        guard checkFrom.valid else { return ["error": checkFrom.error!] }
        let checkTo = validatePath(to)
        guard checkTo.valid else { return ["error": checkTo.error!] }

        guard fm.fileExists(atPath: checkFrom.resolved) else {
            return ["error": "Source not found: \(from)"]
        }

        do {
            try fm.moveItem(atPath: checkFrom.resolved, toPath: checkTo.resolved)
            return ["success": true, "from": checkFrom.resolved, "to": checkTo.resolved]
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    static func deleteFile(params: [String: Any]) async -> Any {
        guard let path = params["path"] as? String else { return ["error": "path required"] }
        let check = validatePath(path)
        guard check.valid else { return ["error": check.error!] }

        let filePath = check.resolved
        guard fm.fileExists(atPath: filePath) else {
            return ["error": "File not found: \(path)"]
        }

        #if canImport(AppKit)
        let url = URL(fileURLWithPath: filePath)
        return await withCheckedContinuation { continuation in
            NSWorkspace.shared.recycle([url]) { trashedURLs, error in
                if let error {
                    continuation.resume(returning: ["error": error.localizedDescription] as Any)
                } else {
                    continuation.resume(returning: ["success": true, "path": filePath, "trashedTo": trashedURLs.first?.value.path ?? "Trash"] as Any)
                }
            }
        }
        #else
        return ["error": "Trash not available on this platform"]
        #endif
    }

    static func fileInfo(params: [String: Any]) async -> Any {
        guard let path = params["path"] as? String else { return ["error": "path required"] }
        let check = validatePath(path)
        guard check.valid else { return ["error": check.error!] }

        let filePath = check.resolved
        guard fm.fileExists(atPath: filePath) else {
            return ["error": "File not found: \(path)"]
        }

        do {
            let attrs = try fm.attributesOfItem(atPath: filePath)
            let formatter = ISO8601DateFormatter()

            var isDir: ObjCBool = false
            fm.fileExists(atPath: filePath, isDirectory: &isDir)

            var info: [String: Any] = [
                "path": filePath,
                "type": isDir.boolValue ? "directory" : "file",
                "size": attrs[.size] as? Int ?? 0,
            ]

            if let created = attrs[.creationDate] as? Date {
                info["created"] = formatter.string(from: created)
            }
            if let modified = attrs[.modificationDate] as? Date {
                info["modified"] = formatter.string(from: modified)
            }
            if let posix = attrs[.posixPermissions] as? Int {
                info["permissions"] = String(posix, radix: 8)
            }

            return info
        } catch {
            return ["error": error.localizedDescription]
        }
    }

    static func searchFiles(params: [String: Any]) async -> Any {
        guard let query = params["query"] as? String else { return ["error": "query required"] }
        let searchPath = params["path"] as? String

        // Validate search path if provided
        if let searchPath {
            let check = validatePath(searchPath)
            guard check.valid else { return ["error": check.error!] }
        }

        let home = NSHomeDirectory()
        let resolvedPath: String
        if let searchPath {
            resolvedPath = (NSString(string: searchPath).expandingTildeInPath as NSString).resolvingSymlinksInPath
        } else {
            resolvedPath = home
        }

        // Use mdfind (Spotlight) for search
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        process.arguments = ["-onlyin", resolvedPath, "-name", query]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            guard let output = String(data: data, encoding: .utf8) else {
                return ["error": "Failed to read search results"]
            }

            let results = output.split(separator: "\n")
                .map(String.init)
                .filter { $0.hasPrefix(home) } // Extra safety: only results in home dir
                .prefix(maxSearchResults)
                .map { path -> [String: Any] in
                    var isDir: ObjCBool = false
                    fm.fileExists(atPath: path, isDirectory: &isDir)
                    var item: [String: Any] = [
                        "path": path,
                        "name": (path as NSString).lastPathComponent,
                        "type": isDir.boolValue ? "directory" : "file",
                    ]
                    if let attrs = try? fm.attributesOfItem(atPath: path) {
                        item["size"] = attrs[.size] as? Int ?? 0
                    }
                    return item
                }

            return ["query": query, "count": results.count, "results": Array(results)]
        } catch {
            return ["error": error.localizedDescription]
        }
    }
}
