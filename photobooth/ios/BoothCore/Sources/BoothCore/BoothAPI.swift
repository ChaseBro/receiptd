// Client for the booth Worker (photobooth/src/index.ts). Same endpoints and
// bodies the web booth uses; every call carries the shared PIN in
// `x-booth-pin`. A 401 means the PIN changed: the app goes back to the lock.

import Foundation

public struct BoothEvent: Codable, Equatable, Sendable {
    public var slug: String
    public var name: String
    public var date: String?
    /// Themes the booth offers while this event is active (empty = all).
    public var themes: [String]
    /// Theme the booth switches to when the event becomes active.
    public var theme: String?
    /// Printed under the ticket stub (replaces the per-device footer).
    public var footer: String?
    /// Print a QR code linking to the guest's photos on every strip.
    public var qr: Bool
    /// Public album token: strips link to /a/<share>/<session id>.
    public var share: String?
}

public struct PrinterHealth: Codable, Equatable, Sendable {
    public var code: Int?
    public var text: String?
    public var paperOut: Bool
    public var paperLow: Bool?
    public var coverOpen: Bool
    public var error: Bool
    public var online: Bool?
    public var lastSeenSec: Int?

    public init(code: Int? = nil, text: String? = nil, paperOut: Bool = false, paperLow: Bool? = nil, coverOpen: Bool = false,
                error: Bool = false, online: Bool? = nil, lastSeenSec: Int? = nil) {
        self.code = code; self.text = text; self.paperOut = paperOut; self.paperLow = paperLow; self.coverOpen = coverOpen
        self.error = error; self.online = online; self.lastSeenSec = lastSeenSec
    }

    /// What the printer needs (public/printer-state.js printerState). Status codes (paper out, cover
    /// open, error) win even when stale. A stale check-in with no error is `.asleep` (with MQTT the
    /// printer only polls when poked) until a wake-up nudge goes unanswered (`wake.failed`): `.offline`.
    public func state(wake: PrinterWake? = nil) -> PrinterState {
        if paperOut { return .paperOut }
        if coverOpen { return .coverOpen }
        if error { return .error }
        if online != true { return wake?.failed == true ? .offline : .asleep }
        if paperLow == true { return .paperLow }
        return .ready
    }
    public var state: PrinterState { state(wake: nil) }

    /// The one-line adult label for a tap on the printer badge (printer-state.js printerHint).
    public func hint(now: Date = Date(), calendar: Calendar = .current, wake: PrinterWake? = nil) -> String {
        switch state(wake: wake) {
        case .offline:
            let seen = lastSeenSec.map { "last seen \(PrinterHealth.clock(now.addingTimeInterval(-Double($0)), calendar))" } ?? "not seen yet"
            return "Printer offline · \(seen) · Check its power & Wi-Fi"
        case .asleep: return wake?.phase == .waking ? "Printer napping · waking it up…" : "Printer napping · last check-in \(PrinterHealth.ago(lastSeenSec))"
        case .paperOut: return "Out of paper"
        case .coverOpen: return "Cover open"
        case .error: return "Printer error — turn it off and on"
        case .paperLow: return "Paper low"
        case .ready: return "Printer ready"
        }
    }

    /// "just now" / "5 min ago" / "2h ago" / "3 days ago" (printer-state.js ago).
    public static func ago(_ sec: Int?) -> String {
        guard let s = sec else { return "never" }
        if s < 90 { return "just now" }
        if s < 3600 { return "\(Int((Double(s) / 60).rounded())) min ago" }
        if s < 172_800 { return "\(Int((Double(s) / 3600).rounded()))h ago" }
        return "\(Int((Double(s) / 86400).rounded())) days ago"
    }

    /// "2:14 pm".
    public static func clock(_ d: Date, _ cal: Calendar = .current) -> String {
        let h = cal.component(.hour, from: d), m = cal.component(.minute, from: d)
        return "\(h % 12 == 0 ? 12 : h % 12):\(String(format: "%02d", m)) \(h < 12 ? "am" : "pm")"
    }
}

/// Waking a napping printer (printer-state.js wakeStep): with MQTT it only polls when poked, so a
/// stale check-in gets an automatic nudge (at most every `cooldown` s while the booth is in use, or
/// `force`d right before / after a print), then re-checks every `recheck` s; no check-in within
/// `window` s → `failed` (offline), sticky until it checks in.
public struct PrinterWake: Equatable, Sendable {
    public enum Phase: String, Sendable { case idle, waking }
    public static let cooldown: TimeInterval = 120, window: TimeInterval = 25, recheck: TimeInterval = 4
    public var phase: Phase = .idle
    public var nudgedAt: Date = .distantPast
    public var failed = false
    public init(phase: Phase = .idle, nudgedAt: Date = .distantPast, failed: Bool = false) { self.phase = phase; self.nudgedAt = nudgedAt; self.failed = failed }

    /// Advance with a fresh /api/printer answer. Returns whether to POST /api/nudge now, and whether to re-check.
    public mutating func step(_ h: PrinterHealth?, now: Date = Date(), inUse: Bool = true, force: Bool = false) -> (nudge: Bool, recheck: Bool) {
        guard let h else { return (false, false) }
        if h.online == true { phase = .idle; failed = false; return (false, false) }
        if phase == .waking, now.timeIntervalSince(nudgedAt) >= Self.window { phase = .idle; failed = true }
        var nudge = false
        if phase != .waking, force || (inUse && now.timeIntervalSince(nudgedAt) >= Self.cooldown) {
            nudge = true; phase = .waking; nudgedAt = now
        }
        return (nudge, phase == .waking)
    }
}

/// One printer state, in priority order. The camera badge shows those that need a grown-up (loud)
/// and, quietly, a napping printer (`soft`: no "!", no wiggle, no red).
public enum PrinterState: String, CaseIterable, Sendable {
    case paperOut, coverOpen, error, offline, asleep, paperLow, ready
    public var needsAdult: Bool { self == .offline || self == .paperOut || self == .coverOpen || self == .error }
    public var soft: Bool { self == .asleep }
    /// The drawn icon (App/Icons.swift, public/icons.js).
    public var icon: String {
        switch self {
        case .offline: "pOffline"; case .asleep: "pAsleep"; case .paperOut: "pPaperOut"; case .coverOpen: "pCover"
        case .error: "pError"; case .paperLow: "pPaperLow"; case .ready: "pReady"
        }
    }
    /// Classic (emoji) icon style: distinct per problem too.
    public var emoji: String {
        switch self {
        case .offline: "🔌"; case .asleep: "💤"; case .paperOut: "🧻"; case .coverOpen: "🖨️"; case .error: "💥"; case .paperLow: "🧻"; case .ready: "😺"
        }
    }
    /// VoiceOver label for the badge.
    public var label: String {
        switch self {
        case .offline: "Printer offline"; case .asleep: "Printer napping"; case .paperOut: "Printer out of paper"; case .coverOpen: "Printer cover open"
        case .error: "Printer error"; case .paperLow: "Printer paper low"; case .ready: "Printer ready"
        }
    }
}

public struct JobStatus: Decodable, Sendable {
    /// "pending" | "printing" | "completed"
    public var status: String?
    public var position: Int?
    public var printer: PrinterHealth?
}

/// POST /api/sessions/:id/share: a short-lived public "your photos" link to one session.
public struct SessionShare: Decodable, Equatable, Sendable {
    public var token: String
    public var expiresAt: String?
}

public struct PrintJob: Decodable, Sendable { public var id: String; public var copies: Int?; public var position: Int? }

public enum BoothAPIError: Error, Equatable {
    /// 401: wrong or rotated PIN.
    case locked
    case http(Int, String)
    case network
}

public final class BoothAPI: @unchecked Sendable {
    public var server: URL
    public var pin: String
    let session: URLSession

    public static let production = URL(string: "https://booth.receiptd.sh")!

    public init(server: URL = BoothAPI.production, pin: String, session: URLSession = .shared) {
        self.server = server; self.pin = pin; self.session = session
    }

    func request(_ path: String, method: String = "GET", json: Any? = nil) throws -> URLRequest {
        var r = URLRequest(url: server.appendingPathComponent(path))
        r.httpMethod = method
        r.setValue(pin, forHTTPHeaderField: "x-booth-pin")
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.timeoutInterval = 30
        if let json { r.httpBody = try JSONSerialization.data(withJSONObject: json) }
        return r
    }

    func send<T: Decodable>(_ r: URLRequest, as: T.Type) async throws -> T {
        let (data, res): (Data, URLResponse)
        do { (data, res) = try await session.data(for: r) } catch { throw BoothAPIError.network }
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw BoothAPIError.locked }
        guard (200..<300).contains(status) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String ?? "HTTP \(status)"
            throw BoothAPIError.http(status, msg)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private struct OK: Decodable {}

    /// Checks the PIN.
    public func unlock() async throws { _ = try await send(request("api/unlock", method: "POST"), as: OK.self) }

    /// POST /api/print: one bitmap per copy (each relieved for the head heat it meets).
    /// bits: 0/1 per pixel, PRINT_WIDTH wide. All copies go out as one job.
    public func print(bits: [[UInt8]], height: Int, density: Int, speed: Int) async throws -> PrintJob {
        let enc = bits.map { Data(packBits($0, PRINT_WIDTH, height)).base64EncodedString() }
        var body: [String: Any] = ["width": PRINT_WIDTH, "height": height, "bits": enc[0], "density": density, "speed": speed, "copies": bits.count]
        if enc.count > 1 { body["bitsList"] = enc }
        return try await send(request("api/print", method: "POST", json: body), as: PrintJob.self)
    }

    public func job(_ id: String) async throws -> JobStatus {
        let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))) ?? id
        return try await send(request("api/jobs/\(safe)"), as: JobStatus.self)
    }

    /// Re-send the MQTT "poll now" (a lost trigger shouldn't wait for the long fallback poll).
    public func nudge() async { _ = try? await send(request("api/nudge", method: "POST"), as: OK.self) }

    public func printer() async throws -> PrinterHealth { try await send(request("api/printer"), as: PrinterHealth.self) }

    private struct Active: Decodable { var event: BoothEvent? }
    /// The party booths are shooting for right now (set from /party.html), or nil.
    public func activeEvent() async throws -> BoothEvent? { try await send(request("api/events/active"), as: Active.self).event }

    /// A "your photos" link for one session (24 h by default; `ttl` seconds, 1…7 days). Works
    /// with or without a party; the session needn't be uploaded yet (the page waits for it).
    public func sessionShare(_ id: String, ttl: Int? = nil) async throws -> SessionShare {
        let safe = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-"))) ?? id
        return try await send(request("api/sessions/\(safe)/share", method: "POST", json: ttl.map { ["ttl": $0] } ?? [String: Int]()), as: SessionShare.self)
    }

    /// `/s/<token>` on this booth's own server (what the on-screen QR encodes).
    public func sessionShareURL(token: String) -> String {
        var c = URLComponents(url: server, resolvingAgainstBaseURL: false)!
        c.path = "/s/\(token)"; c.query = nil; c.fragment = nil
        return c.string!
    }

    /// The strip QR: that guest's photos in the event album.
    public func albumURL(share: String, session: String) -> String {
        var c = URLComponents(url: server, resolvingAgainstBaseURL: false)!
        c.path = "/a/\(share)/\(session)"; c.query = nil; c.fragment = nil
        return c.string!
    }

    /// Client error reports → Workers logs. Never image data, URLs or the PIN.
    public func log(_ fields: [String: Any]) async {
        guard var r = try? request("api/log", method: "POST", json: fields) else { return }
        r.setValue(nil, forHTTPHeaderField: "x-booth-pin")
        _ = try? await session.data(for: r)
    }
}
