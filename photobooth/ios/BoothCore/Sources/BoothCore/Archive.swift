// Photo archive uploader: port of public/archive.js + archive-codecs.js.
//
// Every session (original frames + the exact printed 1-bit strip) goes to
// POST /api/archive in the background. It never blocks the kid flow: uploads
// run one at a time, pause while a print is being sent, and live in a durable
// on-disk queue (Application Support/archive) that survives relaunches and
// offline spells. Retries back off 5 s → 10 min; the oldest sessions are
// dropped beyond 300 MB. Failures go to /api/log (rate-limited, no image data).

import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

public enum ArchiveLimits {
    public static let queueCapBytes = 300 * 1024 * 1024
    public static let batchBytes = 10 * 1024 * 1024      // server caps a request at 12 MB
    public static let jpegQuality = 0.82
    public static let origMaxPx = 2048
}

/// `<base36 ms>-<8 hex>`; the server buckets by the timestamp inside it.
public func newSessionId(now: Date = Date(), rand: [UInt8]? = nil) -> String {
    let ms = Int64((now.timeIntervalSince1970 * 1000).rounded(.down))
    let r = rand ?? (0..<4).map { _ in UInt8.random(in: 0...255) }
    return String(ms, radix: 36) + "-" + r.map { String(format: "%02x", $0) }.joined()
}

/// [w, h] scaled so the long side is ≤ max (never upscaled).
public func fitSize(_ w: Int, _ h: Int, max m: Int = ArchiveLimits.origMaxPx) -> (Int, Int) {
    let s = min(1, Double(m) / Double(max(w, h)))
    return (max(1, Int(jsRound(Double(w) * s))), max(1, Int(jsRound(Double(h) * s))))
}

/// Retry delay after `tries` failures: 5 s doubling, capped at 10 min.
public func backoffSeconds(_ tries: Int) -> Double { min(600, 5 * pow(2, Double(max(0, tries - 1)))) }

/// Split files into request-sized batches (greedy, in order); no files → one meta-only batch.
public func planBatches(_ files: [(name: String, bytes: Int)], max: Int = ArchiveLimits.batchBytes) -> [[String]] {
    var out: [[String]] = [], cur: [String] = [], size = 0
    for f in files {
        if !cur.isEmpty && size + f.bytes > max { out.append(cur); cur = []; size = 0 }
        cur.append(f.name); size += f.bytes
    }
    if !cur.isEmpty || out.isEmpty { out.append(cur) }
    return out
}

/// Ids of the oldest records to drop so the queue fits in `cap` bytes.
public func pickDrops(_ records: [(id: String, createdAt: Double, bytes: Int)], cap: Int = ArchiveLimits.queueCapBytes) -> [String] {
    var total = records.reduce(0) { $0 + $1.bytes }
    var drops: [String] = []
    for r in records.sorted(by: { $0.createdAt < $1.createdAt }) {
        if total <= cap { break }
        drops.append(r.id); total -= r.bytes
    }
    return drops
}

/// Session metadata (mirrors what the web booth sends; the server sanitizes).
public struct ArchiveMeta: Codable, Equatable, Sendable {
    public var id: String
    public var capturedAt: String?
    public var theme: String?
    public var shots: Int?
    public var faces: [Int?]?
    public var rotations: [Int]?
    public var mirrored: Bool?
    public var ticket: Int?
    public var ua: String?
    public var printed: Bool = false
    public var event: String?
    public var copies: Int?
    public var bytes: [String: Int]?
    public init(id: String) { self.id = id }

    /// Local merge (mirrors the server): later fields win, `printed` is sticky.
    public func merged(with inc: ArchiveMeta) -> ArchiveMeta {
        var out = inc
        out.capturedAt = inc.capturedAt ?? capturedAt; out.theme = inc.theme ?? theme; out.shots = inc.shots ?? shots
        out.faces = inc.faces ?? faces; out.rotations = inc.rotations ?? rotations; out.mirrored = inc.mirrored ?? mirrored
        out.ticket = inc.ticket ?? ticket; out.ua = inc.ua ?? ua; out.event = inc.event ?? event
        out.printed = printed || inc.printed
        if bytes != nil || inc.bytes != nil { out.bytes = (bytes ?? [:]).merging(inc.bytes ?? [:]) { $1 } }
        out.copies = inc.printed ? (inc.copies ?? copies) : (copies ?? inc.copies)
        return out
    }
}

// MARK: codecs

private let CRC_TABLE: [UInt32] = (0..<256).map { n -> UInt32 in
    var c = UInt32(n)
    for _ in 0..<8 { c = c & 1 != 0 ? 0xedb88320 ^ (c >> 1) : c >> 1 }
    return c
}

public func crc32(_ bytes: [UInt8], _ crc: UInt32 = 0) -> UInt32 {
    var c = ~crc
    for b in bytes { c = CRC_TABLE[Int((c ^ UInt32(b)) & 0xff)] ^ (c >> 8) }
    return ~c
}

private func adler32(_ bytes: [UInt8]) -> UInt32 {
    var a: UInt32 = 1, b: UInt32 = 0
    var i = 0
    while i < bytes.count {
        let end = min(i + 5552, bytes.count)
        for j in i..<end { a += UInt32(bytes[j]); b += a }
        a %= 65521; b %= 65521; i = end
    }
    return (b << 16) | a
}

/// zlib stream (header + raw deflate + adler32).
func zlib(_ bytes: [UInt8]) -> [UInt8] {
    let raw = (try? (Data(bytes) as NSData).compressed(using: .zlib) as Data).map { [UInt8]($0) }
    var out: [UInt8] = [0x78, 0x9c]
    if let raw { out += raw } else {
        // stored blocks fallback
        var i = 0
        repeat {
            let part = Array(bytes[i..<min(i + 65535, bytes.count)])
            let last = i + 65535 >= bytes.count
            out.append(last ? 1 : 0)
            let n = UInt16(part.count)
            out += [UInt8(n & 0xff), UInt8(n >> 8), UInt8(~n & 0xff), UInt8(~n >> 8)] + part
            i += 65535
        } while i < bytes.count
    }
    let a = adler32(bytes)
    out += [UInt8(a >> 24), UInt8((a >> 16) & 0xff), UInt8((a >> 8) & 0xff), UInt8(a & 0xff)]
    return out
}

private func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)] }

private func pngChunk(_ type: String, _ data: [UInt8]) -> [UInt8] {
    let td = Array(type.utf8) + data
    return be32(UInt32(data.count)) + td + be32(crc32(td))
}

/// The printed bitmap as a true 1-bit greyscale PNG (1 = black in `bits`).
public func encodeBitPNG(_ bits: [UInt8], _ w: Int, _ h: Int) -> Data {
    let rowBytes = (w + 7) / 8
    var raw = [UInt8](repeating: 0, count: (rowBytes + 1) * h)
    for y in 0..<h {
        let o = y * (rowBytes + 1)
        for x in 0..<w where bits[y * w + x] == 0 { raw[o + 1 + (x >> 3)] |= UInt8(0x80 >> (x & 7)) }   // PNG: 1 = white
    }
    let ihdr = be32(UInt32(w)) + be32(UInt32(h)) + [1, 0, 0, 0, 0]
    let out: [UInt8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] + pngChunk("IHDR", ihdr) + pngChunk("IDAT", zlib(raw)) + pngChunk("IEND", [])
    return Data(out)
}

/// JPEG for the archive: long side ≤ 2048, q 0.82.
public func encodeArchiveJPEG(_ img: CGImage) -> Data? {
    let (w, h) = fitSize(img.width, img.height)
    var src = img
    if w != img.width || h != img.height {
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: Canvas.srgb,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let s = ctx.makeImage() else { return nil }
        src = s
    }
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, src, [kCGImageDestinationLossyCompressionQuality: ArchiveLimits.jpegQuality] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? data as Data : nil
}

// MARK: queue

/// Durable upload queue. One directory per session: record.json + the files.
public actor ArchiveQueue {
    struct FileEntry: Codable { var rev: Int; var bytes: Int }
    struct Record: Codable {
        var id: String
        var createdAt: Double
        var meta: ArchiveMeta
        var metaRev: Int
        var files: [String: FileEntry]
        var tries: Int
        var nextAt: Double
        var bytes: Int { files.values.reduce(0) { $0 + $1.bytes } }
    }

    private let root: URL
    private var api: BoothAPI?
    private var paused = false, flushing = false
    private var inflight: Task<Int, Never>?
    private var logged = 0, lastLog = 0.0
    private var timer: Task<Void, Never>?

    public init(root: URL? = nil) {
        let base = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("archive", isDirectory: true)
        self.root = base
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var u = base; var rv = URLResourceValues(); rv.isExcludedFromBackup = true; try? u.setResourceValues(rv)
    }

    /// Arm retries: soon, then every minute (the app also kicks on foreground / network up).
    public func start(_ api: BoothAPI) {
        self.api = api
        timer?.cancel()
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            while !Task.isCancelled {
                await self?.flush()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    public func setAPI(_ api: BoothAPI) { self.api = api }

    private func dir(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }

    private func load(_ id: String) -> Record? {
        guard let d = try? Data(contentsOf: dir(id).appendingPathComponent("record.json")) else { return nil }
        return try? JSONDecoder().decode(Record.self, from: d)
    }
    private func save(_ r: Record) {
        try? FileManager.default.createDirectory(at: dir(r.id), withIntermediateDirectories: true)
        try? JSONEncoder().encode(r).write(to: dir(r.id).appendingPathComponent("record.json"), options: .atomic)
    }
    private func delete(_ id: String) { try? FileManager.default.removeItem(at: dir(id)) }
    private func all() -> [Record] {
        ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).compactMap { load($0) }
    }

    /// Queue files (+ meta) for a session; replaces same-named files not yet uploaded.
    public func enqueue(_ meta: ArchiveMeta, files: [String: Data] = [:]) {
        let id = meta.id
        var r = load(id) ?? Record(id: id, createdAt: Date().timeIntervalSince1970, meta: ArchiveMeta(id: id), metaRev: 0, files: [:], tries: 0, nextAt: 0)
        r.meta = r.meta.merged(with: meta)
        r.metaRev += 1
        try? FileManager.default.createDirectory(at: dir(id), withIntermediateDirectories: true)
        for (name, data) in files {
            do { try data.write(to: dir(id).appendingPathComponent(name), options: .atomic) } catch { report("enqueue_failed", ["err": "write"]); continue }
            r.files[name] = FileEntry(rev: (r.files[name]?.rev ?? 0) + 1, bytes: data.count)
        }
        r.tries = 0; r.nextAt = 0
        save(r)
        let drops = pickDrops(all().map { ($0.id, $0.createdAt, $0.bytes) })
        for d in drops { delete(d) }
        if !drops.isEmpty { report("queue_full_dropped", ["dropped": drops.count]) }
        kick(after: 1.5)
    }

    /// Sessions waiting to upload (for the adult settings screen).
    public func pending() -> (sessions: Int, bytes: Int) { let a = all(); return (a.count, a.reduce(0) { $0 + $1.bytes }) }

    /// Stop uploading (aborts an in-flight request) — e.g. while a print is being sent.
    public func pause() { paused = true; inflight?.cancel() }
    public func resume(after delay: Double = 3) { paused = false; kick(after: delay) }

    public func kick(after delay: Double = 0) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            await self?.flush()
        }
    }

    private func multipart(_ r: Record, _ names: [String]) throws -> (Data, String) {
        let boundary = "booth-\(UUID().uuidString)"
        var body = Data()
        func part(_ header: String, _ content: Data) {
            body.append("--\(boundary)\r\n\(header)\r\n\r\n".data(using: .utf8)!); body.append(content); body.append("\r\n".data(using: .utf8)!)
        }
        part("Content-Disposition: form-data; name=\"meta\"", try JSONEncoder().encode(r.meta))
        for n in names {
            let type = n.hasSuffix(".png") ? "image/png" : "image/jpeg"
            part("Content-Disposition: form-data; name=\"\(n)\"; filename=\"\(n)\"\r\nContent-Type: \(type)", try Data(contentsOf: dir(r.id).appendingPathComponent(n)))
        }
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        return (body, boundary)
    }

    private func send(_ r: Record, _ names: [String]) async -> Int {
        guard let api, let (body, boundary) = try? multipart(r, names) else { return 0 }
        var req = URLRequest(url: api.server.appendingPathComponent("api/archive"))
        req.httpMethod = "POST"
        req.setValue(api.pin, forHTTPHeaderField: "x-booth-pin")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "content-type")
        req.timeoutInterval = 120
        let task = Task { () -> Int in
            do { let (_, res) = try await api.session.upload(for: req, from: body); return (res as? HTTPURLResponse)?.statusCode ?? 0 } catch { return 0 }
        }
        inflight = task
        let status = await task.value
        inflight = nil
        return status
    }

    /// Upload everything due, one request at a time.
    public func flush() async {
        guard !flushing, !paused, let api, !api.pin.isEmpty else { return }
        flushing = true
        defer { flushing = false }
        let now = Date().timeIntervalSince1970
        let due = all().filter { $0.nextAt <= now }.sorted { $0.createdAt < $1.createdAt }
        for snap in due {
            if paused { break }
            let batches = planBatches(snap.files.map { ($0.key, $0.value.bytes) }.sorted { $0.0 < $1.0 })
            for names in batches {
                if paused { return }
                let status = await send(snap, names)
                if (200..<300).contains(status) { markSent(snap.id, names.reduce(into: [:]) { $0[$1] = snap.files[$1]!.rev }, snap.metaRev); continue }
                if paused { return }                       // aborted by pause(): no penalty
                if status == 401 { return }                // PIN changed: wait for re-unlock
                if status == 0 || status >= 500 || status == 408 || status == 429 {
                    if var rec = load(snap.id), rec.metaRev == snap.metaRev {
                        rec.tries += 1; rec.nextAt = Date().timeIntervalSince1970 + backoffSeconds(rec.tries); save(rec)
                        kick(after: backoffSeconds(rec.tries) + 0.25)
                        if status != 0 { report("upload_retry", ["status": status, "tries": rec.tries]) }
                    }
                    if status == 0 { return }              // offline: stop this round
                } else {
                    delete(snap.id)                        // rejected for good: don't poison the queue
                    report("upload_rejected", ["status": status, "id": snap.id])
                }
                break
            }
        }
    }

    /// Drop files that were uploaded (unless replaced meanwhile); delete the record once nothing's left.
    private func markSent(_ id: String, _ sentRevs: [String: Int], _ metaRev: Int) {
        guard var r = load(id) else { return }
        for (n, rev) in sentRevs where r.files[n]?.rev == rev {
            r.files[n] = nil
            try? FileManager.default.removeItem(at: dir(id).appendingPathComponent(n))
        }
        if r.files.isEmpty && r.metaRev == metaRev { delete(id) } else { r.tries = 0; r.nextAt = 0; save(r) }
    }

    private func report(_ code: String, _ extra: [String: Any] = [:]) {
        let now = Date().timeIntervalSince1970
        guard logged < 20, now - lastLog >= 300, let api else { return }
        logged += 1; lastLog = now
        var f = extra; f["msg"] = "archive:" + code; f["ua"] = "ios-booth"
        Task { await api.log(f) }
    }
}
