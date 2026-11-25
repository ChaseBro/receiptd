// Passing the booth to another phone, peer to peer: links that carry the booth
// PIN, and the setup links the app opens. Mirrors public/share.js.

import Foundation

public enum BoothLinks {
    /// The app's TestFlight sign-up (microapps apps.yaml `booth.join_url`). Once the app is
    /// installed, the same URL is a universal link (applinks:join.receiptd.sh, AASA path /booth).
    public static let join = URL(string: "https://join.receiptd.sh/booth?k=_Txpzn6Mg2mI")!

    /// `https://booth.example` for any server URL (drops path, query, fragment).
    public static func origin(_ server: URL) -> String {
        var c = URLComponents()
        c.scheme = server.scheme; c.host = server.host(); c.port = server.port
        return c.string ?? server.absoluteString
    }

    /// The web booth, unlocked: `<origin>/#pin=<PIN>` (index.html saves it, then drops it from the URL).
    public static func web(server: URL, pin: String) -> URL {
        URL(string: "\(origin(server))/#pin=\(encode(pin))")!
    }

    /// The app: the TestFlight join link plus `#server=<origin>&key=<PIN>`. The join Worker never
    /// sees the fragment; the installed app reads it (`Pairing`).
    public static func app(server: URL, pin: String, join: URL = BoothLinks.join) -> URL {
        var c = URLComponents(url: join, resolvingAgainstBaseURL: false)!
        c.percentEncodedFragment = "server=\(encode(origin(server)))&key=\(encode(pin))"
        return c.url!
    }

    /// Fragment-safe value: readable (`https://…` stays as is), but `& = + # %` and spaces are escaped.
    static func encode(_ s: String) -> String {
        var ok = CharacterSet.urlFragmentAllowed
        ok.remove(charactersIn: "&=+#%")
        return s.addingPercentEncoding(withAllowedCharacters: ok) ?? s
    }
}

/// A setup link: `booth://setup#server=https://…&key=<PIN>`, or the join link once the app is
/// installed, `https://join.receiptd.sh/booth?k=…#server=…&key=…` (a universal link).
public struct Pairing: Equatable, Sendable {
    public var server: URL
    public var key: String?

    public init?(url: URL) {
        let joinLink = url.scheme == "https" && url.host() == BoothLinks.join.host() && url.path() == BoothLinks.join.path()
        guard url.scheme == "booth" || joinLink, let frag = url.fragment(percentEncoded: true) else { return nil }
        var q: [String: String] = [:]
        for part in frag.split(separator: "&") {
            let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { q[kv[0]] = kv[1].removingPercentEncoding ?? kv[1] }
        }
        guard let s = q["server"], let server = URL(string: s), let host = server.host(),
              server.scheme == "https" || (server.scheme == "http" && ["localhost", "127.0.0.1"].contains(host))   // http: local dev only
        else { return nil }
        self.server = server
        let key = q["key"]?.trimmingCharacters(in: .whitespaces)
        self.key = key?.isEmpty == false ? key : nil
    }
}
