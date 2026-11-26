// Native strips vs the web app's, byte for byte. Fixtures come from the web
// app's own frames.js/raster.js in WebKit: `node ios/parity/gen.mjs` (from
// photobooth/). They're gitignored (~30 MB); these tests skip without them.
// On a mismatch, ref | port | diff PNGs land in $TMPDIR/booth-parity/.

import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
@testable import BoothCore

private let DIR = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/strips")

private struct Manifest: Decodable {
    struct Stub: Decodable { let label: String; let year: String }
    struct FrameInfo: Decodable { let w: Int; let h: Int }
    struct Case: Decodable {
        let name, theme, footer, qr: String
        let seed, ticket, copies, H: Int
        let sinkStart, sinkEnd, gain: Double
        let frames: [String]
        let faces: [[Box]]?
        let layout: L
        let tileSizes: [[Int]]
        struct L: Decodable { let qrY: Double; let qrSide: Int; let stubY: Double }
    }
    struct Text: Decodable { let s: String; let size, x, y, width: Double; let align, base: String; let color, bg: String?; let stroke, max: Double?; let emoji: Bool? }
    let stub: Stub; let frames: [String: FrameInfo]; let cases: [Case]; let text: [Text]
}

private func inflate(_ name: String) throws -> [UInt8] {
    let z = try Data(contentsOf: DIR.appendingPathComponent(name))
    return [UInt8](try (z as NSData).decompressed(using: .zlib) as Data)
}

/// Largest per-channel difference.
private func maxDelta(_ a: [UInt8], _ b: [UInt8]) -> Int { zip(a, b).reduce(0) { max($0, abs(Int($1.0) - Int($1.1))) } }

private func diffCount(_ a: [UInt8], _ b: [UInt8]) -> Int {
    stride(from: 0, to: min(a.count, b.count), by: 4).filter { a[$0] != b[$0] || a[$0 + 1] != b[$0 + 1] || a[$0 + 2] != b[$0 + 2] }.count
}

private func writeDiff(_ name: String, _ ref: [UInt8], _ port: [UInt8], w: Int, h: Int, stride: Int) {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("booth-parity")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var img = [UInt8](repeating: 0, count: w * 3 * h)
    for y in 0..<h { for x in 0..<w {
        let i = (y * w + x) * stride, a = ref[i], b = port[i]
        img[y * w * 3 + x] = a; img[y * w * 3 + w + x] = b; img[y * w * 3 + 2 * w + x] = a == b ? 0 : 255
    } }
    let ctx = CGContext(data: &img, width: w * 3, height: h, bitsPerComponent: 8, bytesPerRow: w * 3, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
    let dest = CGImageDestinationCreateWithURL(dir.appendingPathComponent("\(name).png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil); CGImageDestinationFinalize(dest)
}

final class StripParityTests: XCTestCase {
    private var manifest: Manifest!

    override func setUpWithError() throws {
        let m = DIR.appendingPathComponent("manifest.json")
        try XCTSkipUnless(FileManager.default.fileExists(atPath: m.path), "run node ios/parity/gen.mjs first")
        manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: m))
    }

    private func segments(_ c: Manifest.Case) -> [DitherSegment] {
        let main = ThermalOptions(gain: c.gain, bleed: 0)
        if c.layout.qrSide > 0 {
            return [DitherSegment(y0: 0, y1: Int(c.layout.qrY), opts: main),
                    DitherSegment(y0: Int(c.layout.qrY), y1: c.H, opts: ThermalOptions(gain: 0, bleed: 0, relief: nil))]
        }
        return [DitherSegment(y0: 0, y1: c.H, opts: main)]
    }

    private func frame(_ key: String) throws -> CGImage {
        let info = manifest.frames[key]!
        let cv = Canvas(info.w, info.h)
        cv.putRGBA(try inflate("frame-\(key).z"))
        return cv.makeImage()
    }

    private func options(_ c: Manifest.Case) -> ComposeOptions {
        var o = ComposeOptions()
        o.theme = c.theme; o.seed = c.seed; o.footer = c.footer; o.ticket = c.ticket; o.qr = c.qr; o.faces = c.faces
        o.date = StubDate(label: manifest.stub.label, year: manifest.stub.year)
        return o
    }

    /// Raster only: the web app's composed strip → Swift dither → the same bits, every copy.
    func testDitherMatchesWeb() throws {
        for c in manifest.cases {
            let gray = luminance(try inflate("\(c.name).rgba.z"), PRINT_WIDTH, c.H)
            let r = ditherStrip(gray, w: PRINT_WIDTH, h: c.H, segments: segments(c), copies: c.copies, sinkStart: c.sinkStart)
            for k in 0..<c.copies {
                let want = try inflate("\(c.name).bits\(k).z")
                let bad = zip(want, r.bits[k]).filter { $0 != $1 }.count
                XCTAssertEqual(bad, 0, "\(c.name) copy \(k + 1): \(bad) dots differ")
            }
            XCTAssertEqual(r.sink, c.sinkEnd, "\(c.name) head heat")
        }
    }

    /// Every photo: cover-crop resample, then toneMap on the web's own crop.
    func testPhotoTilesMatchWeb() throws {
        var failures: [String] = []
        for c in manifest.cases { for (i, size) in c.tileSizes.enumerated() {
            let (w, h) = (size[0], size[1])
            let f = try frame(c.frames[i] + String(i))
            let crop = coverCrop(Double(f.width), Double(f.height), Double(w), Double(h))
            let cv = Canvas(w, h)
            cv.drawImage(f, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, Double(w), Double(h))
            let want = try inflate("\(c.name).tile\(i).z")
            let badCrop = diffCount(want, cv.getImageData())
            var o = ToneOptions(); o.width = w; o.height = h; o.faces = facesToTile(c.faces?[i], crop, Double(w), Double(h))
            let tone = toneMap(luminance(want, w, h), o)
            let wantTone = try inflate("\(c.name).tone\(i).z").withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
            let badTone = zip(tone, wantTone).filter { $0.bitPattern != $1.bitPattern }.count
            if badCrop + badTone > 0 { failures.append("\(c.name) #\(i + 1): crop \(badCrop) px, tone \(badTone) px") }
        } }
        XCTAssert(failures.isEmpty, failures.joined(separator: "\n"))
    }

    /// Ticket-stub / film / footer / calibration text, one item per canvas.
    func testTextMatchesWeb() throws {
        var failures: [String] = []
        for (i, t) in manifest.text.enumerated() {
            let c = Canvas(576, 120)
            c.fillStyle(t.bg == "#000" ? Canvas.ink : Canvas.paper); c.fillRect(0, 0, 576, 120)
            c.font(t.emoji == true ? .emoji(t.size) : .display(t.size))
            c.textAlign(["start": .start, "right": .right, "center": .center][t.align]!)
            c.textBaseline(t.base == "middle" ? .middle : .alphabetic)
            c.fillStyle(t.color == "#fff" ? Canvas.paper : Canvas.ink)
            c.fillText(t.s, t.x, t.y, maxWidth: t.max)
            if let sw = t.stroke { c.lineWidth = sw; c.strokeStyle(Canvas.ink); c.strokeText(t.s, t.x, t.y) }
            XCTAssertEqual(c.measureText(t.s), t.width, accuracy: 0.01, "width of \(t.s)")
            let want = try inflate("text\(i).z"), got = c.getImageData()
            let bad = diffCount(want, got)
            if bad > 0 && !(t.stroke != nil && bad <= 16 && maxDelta(want, got) <= 1) { failures.append("\(t.s) @\(t.size)\(t.stroke != nil ? " stroked" : "")\(t.max != nil ? " squeezed" : ""): \(bad) px"); writeDiff("text\(i)", want, got, w: 576, h: 120, stride: 4) }
        }
        print("text mismatches:", failures)
        XCTAssert(failures.isEmpty, failures.joined(separator: "\n"))
    }

    /// Compose: same frames + options → the same RGBA strip as frames.js, and the same bits.
    func testComposeMatchesWeb() throws {
        var failures: [String] = []
        var dotsOff = 0, dotsAll = 0
        for c in manifest.cases {
            let frames = try c.frames.enumerated().map { try frame($0.element + String($0.offset)) }
            let (canvas, L) = compose(frames, options(c))
            XCTAssertEqual(L.H, c.H, "\(c.name) height")
            guard L.H == c.H else { continue }
            let want = try inflate("\(c.name).rgba.z"), got = canvas.getImageData()
            let bad = diffCount(want, got)
            let r = ditherStrip(luminance(got, PRINT_WIDTH, c.H), w: PRINT_WIDTH, h: c.H, segments: segments(c), copies: 1, sinkStart: c.sinkStart)
            let wantBits = try inflate("\(c.name).bits0.z")
            let dots = zip(wantBits, r.bits[0]).filter { $0 != $1 }.count
            dotsOff += dots; dotsAll += wantBits.count
            XCTAssertEqual(dots, 0, "\(c.name): printed dots differ")
            // Known residue: CG's text-stroke path differs from WebKit's on a few
            // anti-aliased pixels of the outlined ticket number (±1 grey, never a dot).
            if bad > 0 && (bad > 24 || maxDelta(want, got) > 1) || dots > 0 {
                failures.append("\(c.name): \(bad) px (max ±\(maxDelta(want, got))), \(dots) dots")
                writeDiff(c.name, want, got, w: PRINT_WIDTH, h: c.H, stride: 4)
            }
        }
        print("compose mismatches:", failures, "dots off: \(dotsOff) of \(dotsAll)")
        XCTAssert(failures.isEmpty, "composed pixels differ:\n" + failures.joined(separator: "\n"))
    }

    func testStubDateMatchesWeb() throws {
        var comps = DateComponents(); comps.year = 2026; comps.month = 11; comps.day = 26; comps.hour = 17; comps.minute = 39
        let tz = TimeZone(identifier: "America/New_York")!
        var cal = Calendar(identifier: .gregorian); cal.timeZone = tz
        let d = StubDate(cal.date(from: comps)!, timeZone: tz)
        XCTAssertEqual(d.label, manifest.stub.label); XCTAssertEqual(d.year, manifest.stub.year)
    }

    /// Every emoji the themes put on a strip has baked art (else it'd render live and drift).
    func testEveryStickerIsBaked() {
        let used: [(String, Double)] = [("🎈", 74), ("🥳", 74), ("🎂", 74), ("🎁", 74), ("🦕", 96), ("🦖", 96), ("🦖", 70), ("🦕", 70), ("🥚", 70), ("🌋", 70),
            ("🚀", 100), ("👽", 66), ("🛸", 66), ("🌙", 66), ("🪐", 66), ("🦃", 78), ("🦃", 70), ("🥧", 70), ("🌽", 70), ("🍗", 70),
            ("🥧", 70), ("🍗", 72), ("🌽", 72), ("🥧", 72), ("🍠", 72), ("🍁", 66), ("🐿️", 66), ("🍂", 66), ("🌰", 66), ("🦉", 72),
            ("🦃", 64), ("🌟", 64), ("🥧", 64), ("🌙", 64), ("🌽", 92), ("🎃", 68), ("🍎", 68), ("🌽", 68), ("🍇", 68), ("📲", 72)]
        for (e, s) in used { XCTAssert(Stickers.isBaked(e, size: s), "\(e) @\(s) not baked") }
    }
}
