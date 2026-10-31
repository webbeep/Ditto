import Darwin
import Foundation

// The bundled llama.cpp server (router mode): started when the agent first
// needs a model, on a random loopback port with a per-launch key only this
// process knows; stopped after 10 idle minutes, when the user turns models
// off, on critical memory pressure while no agent is open, and on quit.
@MainActor
final class ModelRuntime {
  static let shared = ModelRuntime()

  enum Target: Int {
    case runtime = 0
    case strands = 1
  }

  // Told when the Mac runs low on memory (true: critical).
  var onMemoryPressure: ((Bool) -> Void)?

  private var process: Process?
  private var port = 0
  // A runtime someone else runs (the self-test's mock), on loopback only.
  private var external: (url: URL, key: String)?
  private var strands: URL?
  private var lastUse = Date()
  private var idleTimer: Timer?
  private var pressure: DispatchSourceMemoryPressure?
  private let apiKey = (0..<24).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }
    .joined()
  private static let idleLimit: TimeInterval = 600

  private init() {
    let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical],
                                                         queue: .main)
    source.setEventHandler { [weak self, weak source] in
      let critical = source?.data.contains(.critical) ?? false
      MainActor.assumeIsolated {
        self?.memoryPressure(critical: critical)
      }
    }
    source.resume()
    pressure = source
  }

  var isRunning: Bool {
    external != nil || process?.isRunning == true
  }

  // Serves the agent from a runtime already running on this Mac instead of
  // the bundled one (the self-test's mock).
  func useExternal(_ url: URL, key: String) {
    guard ["127.0.0.1", "localhost", "::1"].contains(url.host() ?? "") else { return }
    stop()
    external = (url, key)
  }

  func start(preset: String, memoryMarginMB: Int) async -> Bool {
    lastUse = Date()
    if external != nil {
      return await ping()
    }
    if isRunning {
      return true
    }
    stopStale()
    let presetFile = Paths.models.appendingPathComponent("preset.ini")
    try? preset.write(to: presetFile, atomically: true, encoding: .utf8)
    guard FileManager.default.isExecutableFile(atPath: Paths.runtime.path),
          let port = Self.freePort() else { return false }

    let server = Process()
    server.executableURL = Paths.runtime
    server.arguments = [
      "--host", "127.0.0.1", "--port", String(port), "--api-key", apiKey,
      "--models-preset", presetFile.path, "--models-max", "2",
      "--models-memory-margin", String(memoryMarginMB),
      "--sleep-idle-seconds", "300", "--no-webui",
    ]
    var environment = ProcessInfo.processInfo.environment
    environment["LLAMA_CACHE"] = Paths.models.path
    server.environment = environment
    let log = Paths.file("runtime.log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let handle = try? FileHandle(forWritingTo: log)
    server.standardOutput = handle
    server.standardError = handle
    do {
      try server.run()
    } catch {
      return false
    }
    process = server
    self.port = port
    try? String(server.processIdentifier).write(to: Paths.file("runtime.pid"),
                                               atomically: true, encoding: .utf8)
    // Ready once it answers (loading the router takes a moment).
    for _ in 0..<150 {
      guard server.isRunning else {
        process = nil
        return false
      }
      if await ping() {
        startIdleTimer()
        return true
      }
      try? await Task.sleep(nanoseconds: 200_000_000)
    }
    stop()
    return false
  }

  func stop() {
    process?.terminate()
    process = nil
    idleTimer?.invalidate()
    idleTimer = nil
    try? FileManager.default.removeItem(at: Paths.file("runtime.pid"))
  }

  // The strands-decider sidecar, on loopback only.
  func setStrands(_ endpoint: String) {
    guard let url = URL(string: endpoint),
          ["127.0.0.1", "localhost", "::1"].contains(url.host ?? "") else {
      strands = nil
      return
    }
    strands = url
  }

  func request(_ target: Target, method: String, path: String,
               body: String) async -> (status: Int, body: String) {
    guard let request = makeRequest(target, method: method, path: path, body: body) else {
      return (0, "The model runtime is not running.")
    }
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      return ((response as? HTTPURLResponse)?.statusCode ?? 0,
              String(decoding: data, as: UTF8.self))
    } catch {
      return (0, error.localizedDescription)
    }
  }

  // Server-sent events, one `data:` line per event, as they arrive.
  func stream(_ target: Target, path: String, body: String,
              onEvent: @escaping (String) -> Void) async -> Int {
    guard let request = makeRequest(target, method: "POST", path: path, body: body) else {
      return 0
    }
    do {
      let (bytes, response) = try await URLSession.shared.bytes(for: request)
      for try await line in bytes.lines where line.hasPrefix("data:") {
        lastUse = Date()
        onEvent(line + "\n\n")
      }
      return (response as? HTTPURLResponse)?.statusCode ?? 0
    } catch {
      return 0
    }
  }

  private func makeRequest(_ target: Target, method: String, path: String,
                           body: String) -> URLRequest? {
    lastUse = Date()
    let base: URL?
    switch target {
    case .runtime:
      base = external?.url ?? (isRunning ? URL(string: "http://127.0.0.1:\(port)") : nil)
    case .strands: base = strands
    }
    guard let base, let url = URL(string: path, relativeTo: base) else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 600)
    request.httpMethod = method
    if target == .runtime {
      request.setValue("Bearer \(external?.key ?? apiKey)", forHTTPHeaderField: "Authorization")
    }
    if !body.isEmpty {
      request.httpBody = Data(body.utf8)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }

  private func ping() async -> Bool {
    guard let request = makeRequest(.runtime, method: "GET", path: "/models", body: "") else {
      return false
    }
    let response = try? await URLSession.shared.data(for: request).1
    return (response as? HTTPURLResponse)?.statusCode == 200
  }

  private func startIdleTimer() {
    idleTimer?.invalidate()
    idleTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
      MainActor.assumeIsolated {
        let runtime = ModelRuntime.shared
        if Date().timeIntervalSince(runtime.lastUse) > Self.idleLimit &&
            !Services.shared.agentVisibleSomewhere {
          runtime.stop()
        }
      }
    }
  }

  private func memoryPressure(critical: Bool) {
    onMemoryPressure?(critical)
    if critical && !Services.shared.agentVisibleSomewhere {
      stop()
    }
  }

  // A runtime left behind by a crash.
  private func stopStale() {
    guard let text = try? String(contentsOf: Paths.file("runtime.pid"), encoding: .utf8),
          let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
    var buffer = [CChar](repeating: 0, count: 4096)
    if proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0,
       String(cString: buffer).hasSuffix("/llama-server") {
      kill(pid, SIGTERM)
    }
  }

  private static func freePort() -> Int? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    address.sin_port = 0
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) }
    }
    guard bound == 0 else { return nil }
    let named = withUnsafeMutablePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
    }
    guard named == 0 else { return nil }
    return Int(UInt16(bigEndian: address.sin_port))
  }
}

enum SystemMemory {
  static var totalMB: Int {
    Int(ProcessInfo.processInfo.physicalMemory / 1_048_576)
  }

  // Free, inactive and purgeable pages: what can be had without swapping.
  static var availableMB: Int {
    var stats = vm_statistics64()
    var count = mach_msg_type_number_t(
      MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &stats) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return totalMB / 2 }
    let pages = UInt64(stats.free_count) + UInt64(stats.inactive_count) +
      UInt64(stats.purgeable_count)
    return Int(pages * UInt64(vm_kernel_page_size) / 1_048_576)
  }
}
