// Supervisor.swift — runs the ClosedHand stack on this Mac.
//
// What Docker Compose does for the self-host install, this does inside the
// app: a Postgres of our own (bundled, with pgvector), then the bot and the
// webapp as child processes of the app, with the same environment the compose
// file gives them. The setup page then takes over exactly as it does on
// Docker; nothing here knows about keys or accounts.
//
// Layout it expects inside the bundle (see build.sh):
//   Contents/Resources/node/bin/node        the Node runtime
//   Contents/Resources/pg/{bin,lib,share}   relocatable Postgres + pgvector
//   Contents/Resources/app/                 the repo: index.js, lib/, webapp/, ...
// Data lives in ~/Library/Application Support/ClosedHand: pgdata, storage,
// logs, and config.env with the generated secrets (what install.sh writes
// into .env on Docker).

import Foundation
import Combine
import AppKit

enum ServiceState: Equatable {
    case stopped, starting, running
    case failed(String)

    var label: String {
        switch self {
        case .stopped: return "Stopped"
        case .starting: return "Starting"
        case .running: return "Running"
        case .failed(let why): return why
        }
    }
}

final class Supervisor: ObservableObject {
    static let shared = Supervisor()

    @Published var database: ServiceState = .stopped
    @Published var bot: ServiceState = .stopped
    @Published var web: ServiceState = .stopped
    @Published var address: String = ""
    @Published var firstRun = false

    let supportDir: URL
    let logsDir: URL
    private let resources: URL
    private var config: [String: String] = [:]
    private var pgPort = 54329
    private var botPort = 3001
    private var webPort = 3000
    private var botProc: Process?
    private var webProc: Process?
    private var stopping = false
    private var started = false
    private var openedOnce = false
    private var backoff: [String: TimeInterval] = [:]
    private var healthTimer: Timer?
    private let queue = DispatchQueue(label: "ai.closedhand.supervisor")

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        supportDir = base.appendingPathComponent("ClosedHand", isDirectory: true)
        logsDir = supportDir.appendingPathComponent("logs", isDirectory: true)
        // A developer running `swift run` points this at a folder laid out like
        // Contents/Resources; the built app finds its own.
        if let dev = ProcessInfo.processInfo.environment["CLOSEDHAND_RESOURCES"] {
            resources = URL(fileURLWithPath: dev, isDirectory: true)
        } else {
            resources = Bundle.main.resourceURL ?? Bundle.main.bundleURL
        }
    }

    // MARK: paths

    private var nodeBin: URL { resources.appendingPathComponent("node/bin/node") }
    private var pgBin: URL { resources.appendingPathComponent("pg/bin", isDirectory: true) }
    private var appDir: URL { resources.appendingPathComponent("app", isDirectory: true) }
    private var pgData: URL { supportDir.appendingPathComponent("pgdata", isDirectory: true) }
    private var storageDir: URL { supportDir.appendingPathComponent("storage", isDirectory: true) }
    private var configFile: URL { supportDir.appendingPathComponent("config.env") }
    // Unix socket paths are limited to about a hundred characters, and a long
    // account name would push Application Support past that, so the socket
    // lives in the temporary folder instead.
    private var socketDir: String { NSTemporaryDirectory() + "closedhand-pg" }

    var dashboardURL: URL { URL(string: "http://localhost:\(webPort)/")! }
    /// The one account a self-hosted ClosedHand has (lib/admin.js).
    static let adminUserId = "00000000-0000-0000-0000-0000000000ad"

    // MARK: lifecycle

    func start() {
        guard !started else { return }
        started = true
        queue.async { self.boot() }
    }

    private func boot() {
        do {
            try ensureDirectories()
            try loadConfig()
            choosePorts()
            try startPostgres()
            launch("bot")
            launch("web")
            DispatchQueue.main.async { self.startHealthTimer() }
        } catch {
            publish { self.database = .failed(error.localizedDescription) }
            log("supervisor", "boot failed: \(error.localizedDescription)")
        }
    }

    /// Stops everything, in order, and returns when it is done. Called from
    /// the app delegate on quit, so it blocks for at most a few seconds.
    func stop() {
        stopping = true
        DispatchQueue.main.async { self.healthTimer?.invalidate() }
        for proc in [webProc, botProc] { terminate(proc) }
        botProc = nil; webProc = nil
        _ = run(pgBin.appendingPathComponent("pg_ctl"), ["-D", pgData.path, "-m", "fast", "-w", "-t", "20", "stop"])
        publish { self.bot = .stopped; self.web = .stopped; self.database = .stopped }
    }

    // MARK: setup

    private func ensureDirectories() throws {
        for dir in [supportDir, logsDir, storageDir, URL(fileURLWithPath: socketDir)] {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        for name in ["postgres", "bot", "web", "supervisor"] { rotate(name) }
    }

    /// The generated secrets, made once and kept: the same set install.sh puts
    /// in .env. POSTGRES_PASSWORD must stay with the data it initialised.
    private func loadConfig() throws {
        var conf: [String: String] = [:]
        if let text = try? String(contentsOf: configFile, encoding: .utf8) {
            for line in text.split(separator: "\n") {
                guard let eq = line.firstIndex(of: "=") else { continue }
                conf[String(line[..<eq])] = String(line[line.index(after: eq)...])
            }
        }
        var changed = false
        for key in ["POSTGRES_PASSWORD", "WS_AUTH_SECRET", "SANDBOX_TOKEN", "COOKIE_SECRET", "BRIDGE_TOKEN"] where conf[key] == nil {
            conf[key] = randomHex(24); changed = true
        }
        if conf["TOKEN_ENCRYPTION_KEY"] == nil { conf["TOKEN_ENCRYPTION_KEY"] = randomBase64(32); changed = true }
        if conf["WEB_PORT"] == nil { conf["WEB_PORT"] = "3000"; changed = true }
        if conf["BOT_PORT"] == nil { conf["BOT_PORT"] = "3001"; changed = true }
        if conf["PG_PORT"] == nil { conf["PG_PORT"] = "54329"; changed = true }
        config = conf
        if changed { try saveConfig() }
    }

    private func saveConfig() throws {
        let text = config.keys.sorted().map { "\($0)=\(config[$0]!)" }.joined(separator: "\n") + "\n"
        try text.write(to: configFile, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configFile.path)
    }

    /// The saved ports when they are free, otherwise the nearest free ones.
    /// A Docker ClosedHand on the same Mac holds 3000 and 3001, and the app
    /// must not fight it for them.
    private func choosePorts() {
        pgPort = Int(config["PG_PORT"] ?? "") ?? 54329
        botPort = Int(config["BOT_PORT"] ?? "") ?? 3001
        webPort = Int(config["WEB_PORT"] ?? "") ?? 3000
        // Postgres may still be running from the last session (the app was
        // force-quit, say); then its port is taken by us and stays.
        if !postgresRunning() { pgPort = freePort(from: pgPort) }
        webPort = freePort(from: webPort)
        botPort = freePort(from: botPort == webPort ? botPort + 1 : botPort, avoiding: webPort)
        // The ports that worked are the ones to try first next time, so the
        // address stays the same from one launch to the next.
        config["PG_PORT"] = "\(pgPort)"; config["BOT_PORT"] = "\(botPort)"; config["WEB_PORT"] = "\(webPort)"
        try? saveConfig()
        log("supervisor", "ports: dashboard \(webPort), bot \(botPort), database \(pgPort)")
        publish { self.address = "localhost:\(self.webPort)" }
    }

    // MARK: postgres

    private func postgresRunning() -> Bool {
        run(pgBin.appendingPathComponent("pg_ctl"), ["-D", pgData.path, "status"], quiet: true).status == 0
    }

    private func startPostgres() throws {
        publish { self.database = .starting }
        let fm = FileManager.default
        let fresh = !fm.fileExists(atPath: pgData.appendingPathComponent("PG_VERSION").path)
        if fresh {
            publish { self.firstRun = true }
            let pw = supportDir.appendingPathComponent("pw.tmp")
            try (config["POSTGRES_PASSWORD"]! + "\n").write(to: pw, atomically: true, encoding: .utf8)
            defer { try? fm.removeItem(at: pw) }
            let r = run(pgBin.appendingPathComponent("initdb"), ["-D", pgData.path, "-U", "postgres", "--pwfile=\(pw.path)",
                                                                 "--auth-local=trust", "--auth-host=scram-sha-256", "-E", "UTF8", "--locale=en_US.UTF-8"])
            guard r.status == 0 else { throw fail("The database could not be created. \(r.output.suffix(300))") }
        }
        if !postgresRunning() {
            let opts = "-p \(pgPort) -k \(socketDir) -c listen_addresses=127.0.0.1"
            let r = run(pgBin.appendingPathComponent("pg_ctl"), ["-D", pgData.path, "-o", opts, "-l", logsDir.appendingPathComponent("postgres.log").path, "-w", "-t", "60", "start"])
            guard r.status == 0 else { throw fail("The database did not start. \(r.output.suffix(300))") }
        }
        if fresh {
            // What the pgvector image does on its first boot: create the
            // database and apply the baseline schema. Later migrations are
            // the bot's job, as on Docker.
            let psql = pgBin.appendingPathComponent("psql")
            let create = run(psql, ["-h", socketDir, "-p", "\(pgPort)", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE closedhand"])
            guard create.status == 0 else { throw fail("The database could not be set up. \(create.output.suffix(300))") }
            let schema = appDir.appendingPathComponent("migrations/000_baseline_schema.sql").path
            let apply = run(psql, ["-h", socketDir, "-p", "\(pgPort)", "-U", "postgres", "-d", "closedhand", "-v", "ON_ERROR_STOP=1", "-q", "-f", schema])
            guard apply.status == 0 else { throw fail("The database schema could not be applied. \(apply.output.suffix(300))") }
            log("supervisor", "database initialised on port \(pgPort)")
        }
        publish { self.database = .running }
    }

    // MARK: node services

    private func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = nodeBin.deletingLastPathComponent().path + ":/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
        env["LANG"] = "en_US.UTF-8"
        env["CLOSEDHAND_DESKTOP"] = "1"
        env["DB_DRIVER"] = "pg"
        env["DATABASE_URL"] = "postgres://postgres:\(config["POSTGRES_PASSWORD"]!)@127.0.0.1:\(pgPort)/closedhand"
        env["STORAGE_DIR"] = storageDir.path
        env["npm_config_cache"] = storageDir.appendingPathComponent("cache/npm").path
        for key in ["WS_AUTH_SECRET", "SANDBOX_TOKEN", "COOKIE_SECRET", "TOKEN_ENCRYPTION_KEY", "BRIDGE_TOKEN"] { env[key] = config[key] }
        env["BASE_URL"] = "http://localhost:\(webPort)"
        env["BOT_INTERNAL_URL"] = "http://127.0.0.1:\(botPort)"
        env["BOT_WS_URL"] = "http://127.0.0.1:\(botPort)"
        env["SANDBOX_URL"] = ""
        if let sha = Bundle.main.object(forInfoDictionaryKey: "ClosedHandSHA") as? String { env["CLOSEDHAND_SHA"] = sha }
        return env
    }

    private func launch(_ which: String) {
        guard !stopping else { return }
        let proc = Process()
        proc.executableURL = nodeBin
        var env = environment()
        if which == "bot" {
            proc.currentDirectoryURL = appDir
            proc.arguments = ["index.js"]
            env["PORT"] = "\(botPort)"
        } else {
            proc.currentDirectoryURL = appDir.appendingPathComponent("webapp", isDirectory: true)
            proc.arguments = ["server.js"]
            env["PORT"] = "\(webPort)"
        }
        proc.environment = env
        let handle = logHandle(which)
        proc.standardOutput = handle
        proc.standardError = handle
        proc.terminationHandler = { [weak self] p in
            guard let self = self, !self.stopping else { return }
            let why = "Stopped (\(p.terminationStatus)). Restarting."
            self.publish { if which == "bot" { self.bot = .failed(why) } else { self.web = .failed(why) } }
            let delay = min(30, self.backoff[which] ?? 2)
            self.backoff[which] = delay * 2
            self.log("supervisor", "\(which) exited with \(p.terminationStatus); restarting in \(Int(delay))s")
            self.queue.asyncAfter(deadline: .now() + delay) { self.launch(which) }
        }
        do {
            try proc.run()
            if which == "bot" { botProc = proc } else { webProc = proc }
            publish { if which == "bot" { self.bot = .starting } else { self.web = .starting } }
            log("supervisor", "\(which) started (pid \(proc.processIdentifier))")
        } catch {
            publish { if which == "bot" { self.bot = .failed(error.localizedDescription) } else { self.web = .failed(error.localizedDescription) } }
        }
    }

    private func terminate(_ proc: Process?) {
        guard let proc = proc, proc.isRunning else { return }
        proc.terminate()
        let deadline = Date().addingTimeInterval(6)
        while proc.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
    }

    // MARK: health

    private func startHealthTimer() {
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.checkHealth() }
        healthTimer?.fire()
    }

    private func checkHealth() {
        probe(port: botPort) { ok in
            if ok { self.backoff["bot"] = nil; if self.bot != .running { self.bot = .running } }
        }
        probe(port: webPort) { ok in
            if ok {
                self.backoff["web"] = nil
                if self.web != .running {
                    self.web = .running
                    // The Mac side of ClosedHand connects to the server it
                    // shares a bundle with: no pairing code, the token was
                    // made here and given to both.
                    let url = "ws://127.0.0.1:\(self.webPort)/bridge", token = self.config["BRIDGE_TOKEN"] ?? ""
                    Task { @MainActor in BridgeManager.shared.adopt(serverUrl: url, token: token, userId: Supervisor.adminUserId) }
                    // The first time the dashboard is up in this session, and
                    // only on a brand new install, show it: there is a setup
                    // page waiting. Every later launch stays in the menu bar.
                    if self.firstRun && !self.openedOnce { self.openedOnce = true; self.openDashboard() }
                }
            }
        }
    }

    private func probe(port: Int, _ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
        req.timeoutInterval = 3
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse).map { $0.statusCode < 500 } ?? false
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func openDashboard() {
        NSWorkspace.shared.open(dashboardURL)
    }

    // MARK: helpers

    private func publish(_ change: @escaping () -> Void) {
        if Thread.isMainThread { change() } else { DispatchQueue.main.async(execute: change) }
    }

    private func fail(_ message: String) -> NSError {
        NSError(domain: "ClosedHand", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    @discardableResult
    private func run(_ exe: URL, _ args: [String], quiet: Bool = false) -> (status: Int32, output: String) {
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["PGPASSWORD"] = config["POSTGRES_PASSWORD"]
        env["LANG"] = "en_US.UTF-8"
        p.environment = env
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, error.localizedDescription) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let out = String(data: data, encoding: .utf8) ?? ""
        if p.terminationStatus != 0 && !quiet { log("supervisor", "\(exe.lastPathComponent) \(args.joined(separator: " ")) -> \(p.terminationStatus)\n\(out)") }
        return (p.terminationStatus, out)
    }

    private func logHandle(_ name: String) -> FileHandle {
        let url = logsDir.appendingPathComponent("\(name).log")
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        let h = try! FileHandle(forWritingTo: url)
        h.seekToEndOfFile()
        return h
    }

    private func log(_ name: String, _ line: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        let h = logHandle(name)
        h.write("\(stamp) \(line)\n".data(using: .utf8)!)
        try? h.close()
    }

    /// Keeps a log from growing without end: past 20MB it becomes name.log.1.
    private func rotate(_ name: String) {
        let url = logsDir.appendingPathComponent("\(name).log")
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        guard size > 20_000_000 else { return }
        let old = logsDir.appendingPathComponent("\(name).log.1")
        try? FileManager.default.removeItem(at: old)
        try? FileManager.default.moveItem(at: url, to: old)
    }

    private func randomHex(_ bytes: Int) -> String {
        (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
    }

    private func randomBase64(_ bytes: Int) -> String {
        Data((0..<bytes).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
    }

    private func freePort(from start: Int, avoiding: Int? = nil) -> Int {
        var port = start
        while port < start + 200 {
            if port != avoiding && portFree(port) { return port }
            port += 1
        }
        return start
    }

    /// A port is taken when something answers on it. Asking by connecting
    /// rather than binding is what makes this reliable on a Mac: a bind to
    /// 127.0.0.1 can succeed beside a Docker listener on the same port, and
    /// the service then starts on a port another ClosedHand already owns.
    private func portFree(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let r = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        return r != 0 && errno == ECONNREFUSED
    }
}
