import Foundation

enum NotesBridge {
    static func listNotes(params: [String: Any]) async -> Any {
        let limit = params["limit"] as? Int ?? 20
        let cappedLimit = min(limit, 50)
        let script = """
        tell application "Notes"
            set results to {}
            set allNotes to notes
            repeat with i from 1 to \(cappedLimit)
                if i > (count of allNotes) then exit repeat
                set n to item i of allNotes
                set end of results to {|id|:id of n, |name|:name of n, |body|:plaintext of n, |folder|:name of container of n, |modified|:modification date of n as string}
            end repeat
            return results
        end tell
        """
        if let result = await runAppleScriptAsync(script) { return result }
        // Notes not responding, restart and retry
        print("[NotesBridge] Notes not responding, restarting...")
        let _ = runAppleScript("try\ntell application \"Notes\" to quit\ndelay 2\nend try\ndelay 1\ntell application \"Notes\" to launch\ndelay 3")
        return await runAppleScriptAsync(script) ?? [["error": "Notes is not responding even after restart."]]
    }
}
