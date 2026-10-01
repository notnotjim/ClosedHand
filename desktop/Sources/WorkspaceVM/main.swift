// Only this helper owns the Linux VM. It receives no database, Bridge or LLM keys.
// No shared folders, clipboard, host processes, USB devices or host browser profiles.
import Foundation
import Virtualization
import Darwin

struct Options: Decodable {
    let kernel: String
    let initrd: String
    let root: String
    let data: String
    let sockets: String
    let memoryMiB: UInt64
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}
func event(_ state: String) { print("{\"state\":\"\(state)\"}"); fflush(stdout) }

// Unix sockets live in a private directory created by the trusted supervisor.
func unixAddress(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        throw NSError(domain: "Workspace", code: 1, userInfo: [NSLocalizedDescriptionKey: "Workspace socket path is too long"])
    }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { target in target.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
    return address
}
func withAddress<T>(_ address: inout sockaddr_un, _ body: (UnsafePointer<sockaddr>, socklen_t) -> T) -> T {
    withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
}
func connectUnix(_ path: String) -> Int32 {
    guard var address = try? unixAddress(path) else { return -1 }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return -1 }
    guard withAddress(&address, { Darwin.connect(fd, $0, $1) }) == 0 else { close(fd); return -1 }
    return fd
}

// Preserve half-close semantics, including HTTP bodies and WebSocket frames.
// Retaining the VZ connection keeps its owned descriptor alive for both pumps.
func relay(_ host: Int32, _ guest: VZVirtioSocketConnection) {
    let group = DispatchGroup()
    let guestFD = guest.fileDescriptor
    for (source, destination) in [(host, guestFD), (guestFD, host)] {
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            var buffer = [UInt8](repeating: 0, count: 65536)
            while true {
                let count = read(source, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count <= 0 { break }
                var offset = 0
                while offset < count {
                    let sent = buffer.withUnsafeBytes { write(destination, $0.baseAddress!.advanced(by: offset), count - offset) }
                    if sent < 0 && errno == EINTR { continue }
                    if sent <= 0 { shutdown(source, SHUT_RD); break }
                    offset += sent
                }
                if offset != count { break }
            }
            shutdown(destination, SHUT_WR)
            group.leave()
        }
    }
    group.notify(queue: .main) { close(host); guest.close() }
}

final class Machine: NSObject, VZVirtualMachineDelegate, VZVirtioSocketListenerDelegate {
    let options: Options
    let vm: VZVirtualMachine
    private var listener: VZVirtioSocketListener!
    private var servers: [Int32] = []
    private var signals: [DispatchSourceSignal] = []
    private var parentTimer: DispatchSourceTimer?
    private var stopping = false
    private var shutdownConnection: VZVirtioSocketConnection?
    private var lockFD: Int32 = -1
    private let initialParent = getppid()

    init(_ options: Options, token: String) throws {
        self.options = options
        let config = VZVirtualMachineConfiguration()
        let loader = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: options.kernel))
        loader.initialRamdiskURL = URL(fileURLWithPath: options.initrd)
        loader.commandLine = "console=hvc0 root=/dev/vda ro rootwait quiet loglevel=0 init=/usr/local/sbin/closedhand-init closedhand.token=\(token)"
        config.bootLoader = loader
        config.cpuCount = min(2, VZVirtualMachineConfiguration.maximumAllowedCPUCount)
        config.memorySize = options.memoryMiB * 1024 * 1024
        config.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        config.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
        config.socketDevices = [VZVirtioSocketDeviceConfiguration()]
        let nic = VZVirtioNetworkDeviceConfiguration()
        nic.attachment = VZNATNetworkDeviceAttachment()
        config.networkDevices = [nic]
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serial.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: .standardError)
        config.serialPorts = [serial]
        for (path, readOnly) in [(options.root, true), (options.data, false)] {
            let attachment = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: path), readOnly: readOnly)
            config.storageDevices.append(VZVirtioBlockDeviceConfiguration(attachment: attachment))
        }
        try config.validate()
        vm = VZVirtualMachine(configuration: config)
        super.init()
        vm.delegate = self
        lockFD = open(options.data + ".lock", O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            throw NSError(domain: "Workspace", code: 2, userInfo: [NSLocalizedDescriptionKey: "Workspace is already running"])
        }
    }

    var device: VZVirtioSocketDevice { vm.socketDevices[0] as! VZVirtioSocketDevice }

    func start() throws {
        listener = VZVirtioSocketListener()
        listener.delegate = self
        device.setSocketListener(listener, forPort: 9001)
        try serve("agent.sock", port: 8080)
        try serve("desktop.sock", port: 6080)
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { self.stop() }
            source.resume(); signals.append(source)
        }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { if getppid() != self.initialParent { self.stop() } }
        timer.resume(); parentTimer = timer
        vm.start { result in
            switch result {
            case .success: event("started")
            case .failure(let error): fail("Workspace could not start: \(error.localizedDescription)")
            }
        }
    }

    func serve(_ name: String, port: UInt32) throws {
        let path = options.sockets + "/" + name
        var address = try unixAddress(path)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { fail("Workspace socket creation failed") }
        guard withAddress(&address, { Darwin.bind(fd, $0, $1) }) == 0, listen(fd, 32) == 0 else {
            close(fd); fail("Workspace socket could not listen")
        }
        chmod(path, 0o600)
        servers.append(fd)
        DispatchQueue.global(qos: .utility).async {
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 { if errno == EINTR { continue }; break }
                DispatchQueue.main.async {
                    guard !self.stopping, self.vm.state == .running else { close(client); return }
                    self.device.connect(toPort: port) { result in
                        switch result {
                        case .success(let connection): relay(client, connection)
                        case .failure: close(client)
                        }
                    }
                }
            }
        }
    }

    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection, from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard !stopping, connection.destinationPort == 9001 else { return false }
        let fd = connectUnix(options.sockets + "/gateway.sock")
        guard fd >= 0 else { return false }
        relay(fd, connection)
        return true
    }

    func stop() {
        guard !stopping else { return }
        stopping = true
        event("stopping")
        guard vm.state == .running else { exit(0) }
        device.connect(toPort: 9002) { result in
            // Keep this channel open until the guest powers off. Closing it
            // early makes socat terminate the shutdown script before sync.
            if case .success(let connection) = result { self.shutdownConnection = connection }
        }
        // Power loss recovery is ext4's job only if the normal shutdown failed.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
            self.vm.stop { _ in exit(0) }
        }
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) { event("stopped"); exit(0) }
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) { fail("Workspace stopped: \(error.localizedDescription)") }
}

signal(SIGPIPE, SIG_IGN)
guard CommandLine.arguments.count == 2 else { fail("Expected a Workspace configuration file") }
guard let token = ProcessInfo.processInfo.environment["SANDBOX_TOKEN"],
      token.range(of: "^[0-9a-f]{48}$", options: .regularExpression) != nil else { fail("Missing Workspace token") }
do {
    let options = try JSONDecoder().decode(Options.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    let machine = try Machine(options, token: token)
    try machine.start()
    withExtendedLifetime(machine) { dispatchMain() }
} catch { fail(error.localizedDescription) }
