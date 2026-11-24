import Foundation

/// The one server this app talks to, set by a setup link:
/// `booth://setup#server=https://…&key=…`, or the sign's own QR once the app is installed,
/// `https://join.chasebro.com/booth#server=…&key=…` (a universal link: Safari until installed).
struct Pairing: Codable, Equatable {
    var server: URL
    var key: String?

    init?(url: URL) {
        guard url.scheme == "booth" || url.host() == "join.chasebro.com" || url.path().hasSuffix("/setup"),
              let frag = url.fragment(percentEncoded: false) else { return nil }
        var q: [String: String] = [:]
        for part in frag.split(separator: "&") {
            let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { q[kv[0]] = kv[1].removingPercentEncoding ?? kv[1] }
        }
        guard let s = q["server"], let server = URL(string: s), server.scheme == "https" else { return nil }
        self.server = server
        self.key = q["key"]
    }

    private static let storeKey = "pairing"

    static func load() -> Pairing? {
        guard let d = UserDefaults.standard.data(forKey: storeKey) else { return nil }
        return try? JSONDecoder().decode(Pairing.self, from: d)
    }

    func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(self), forKey: Self.storeKey)
    }
}
