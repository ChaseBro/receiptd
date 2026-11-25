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
    /// Kid-facing problem sticker: 🧻 out of paper, 🖨️ anything else, nil when fine.
    public var sticker: String? { paperOut ? "🧻" : (coverOpen || error) ? "🖨️" : nil }
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
