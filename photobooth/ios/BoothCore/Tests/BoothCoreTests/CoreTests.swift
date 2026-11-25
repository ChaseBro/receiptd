import XCTest
import ImageIO
@testable import BoothCore

final class CoreTests: XCTestCase {
    func testSessionId() {
        let id = newSessionId(now: Date(timeIntervalSince1970: 1_764_196_740.123), rand: [0x1a, 0x2b, 0x3c, 0x4d])
        XCTAssertEqual(id, String(Int64(1_764_196_740_123), radix: 36) + "-1a2b3c4d")
        XCTAssertNotNil(id.range(of: #"^[0-9a-z]{8,10}-[0-9a-f]{8}$"#, options: .regularExpression))
    }

    func testBatchesAndDrops() {
        XCTAssertEqual(planBatches([]), [[]])
        XCTAssertEqual(planBatches([("a", 6), ("b", 6), ("c", 3)], max: 10), [["a"], ["b", "c"]])
        XCTAssertEqual(pickDrops([("new", 3, 50), ("old", 1, 50), ("mid", 2, 50)], cap: 100), ["old"])
        XCTAssertEqual(backoffSeconds(1), 5); XCTAssertEqual(backoffSeconds(3), 20); XCTAssertEqual(backoffSeconds(20), 600)
        XCTAssertEqual(fitSize(4032, 3024).0, 2048); XCTAssertEqual(fitSize(4032, 3024).1, 1536); XCTAssertEqual(fitSize(100, 50).0, 100)
    }

    func testMetaMergeKeepsPrintedAndCopies() {
        var a = ArchiveMeta(id: "x"); a.printed = true; a.copies = 3; a.bytes = ["strip.png": 10]
        var b = ArchiveMeta(id: "x"); b.rotations = [90]; b.bytes = ["orig-1.jpg": 5]
        let m = a.merged(with: b)
        XCTAssertTrue(m.printed); XCTAssertEqual(m.copies, 3); XCTAssertEqual(m.rotations, [90]); XCTAssertEqual(m.bytes, ["strip.png": 10, "orig-1.jpg": 5])
    }

    func testCopies() {
        XCTAssertEqual(defaultCopies(nil), 1); XCTAssertEqual(defaultCopies([0, 0]), 1)
        XCTAssertEqual(defaultCopies([2, 4, 1]), 4); XCTAssertEqual(defaultCopies([9]), 6)
        XCTAssertEqual(cooldownSeconds(recentPrints: 1), 1); XCTAssertEqual(cooldownSeconds(recentPrints: 3), 8); XCTAssertEqual(cooldownSeconds(recentPrints: 9), 15)
    }

    func testBitPNG() throws {
        let w = 13, h = 3
        let bits = (0..<(w * h)).map { UInt8($0 % 3 == 0 ? 1 : 0) }
        let png = encodeBitPNG(bits, w, h)
        let src = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
        let img = try XCTUnwrap(CGImageSourceCreateImageAtIndex(src, 0, nil))
        XCTAssertEqual(img.width, w); XCTAssertEqual(png[24], 1, "IHDR bit depth"); XCTAssertEqual(png[25], 0, "greyscale")
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        let p = ctx.data!.assumingMemoryBound(to: UInt8.self)
        for i in 0..<(w * h) { XCTAssertEqual(p[i] == 0 ? 1 : 0, Int(bits[i]), "px \(i)") }
    }

    func testWav() {
        let d = SoundBank.wav(SoundBank.sounds["yay"]!)
        XCTAssertEqual(String(data: d.prefix(4), encoding: .ascii), "RIFF")
        XCTAssertGreaterThan(d.count, 44 + 2 * 22050 / 2)
    }

    func testAlbumURL() {
        let api = BoothAPI(server: URL(string: "https://booth.receiptd.sh")!, pin: "1")
        XCTAssertEqual(api.albumURL(share: "abcdefghjkmn", session: "mfx3k2a1-1a2b3c4d"), "https://booth.receiptd.sh/a/abcdefghjkmn/mfx3k2a1-1a2b3c4d")
    }

    func testSessionShareURL() {
        let api = BoothAPI(server: URL(string: "http://localhost:8788/x?y#z")!, pin: "1")
        XCTAssertEqual(api.sessionShareURL(token: "abcdefghjkmn"), "http://localhost:8788/s/abcdefghjkmn")
    }

    /// The shared session jumps the archive queue (even out of a backoff); then oldest first (archive.js orderDue).
    func testOrderDue() {
        let recs: [(id: String, createdAt: Double, nextAt: Double)] = [("b", 2, 0), ("a", 1, 0), ("late", 0, 5000), ("mine", 9, 9999)]
        XCTAssertEqual(orderDue(recs, priority: nil, now: 1000), ["a", "b"])
        XCTAssertEqual(orderDue(recs, priority: "mine", now: 1000), ["mine", "a", "b"])
        XCTAssertEqual(orderDue(recs, priority: "b", now: 1000), ["b", "a"])
        XCTAssertEqual(orderDue(recs, priority: "gone", now: 1000), ["a", "b"])
    }

    func testCalibrationSegmentsCoverStrip() {
        let (_, H, bandH) = calibrationGray(CALIBRATION_GAINS)
        let segs = calibrationSegments(H: H, bandH: bandH)
        XCTAssertEqual(segs.first?.y0, 0); XCTAssertEqual(segs.last?.y1, H)
        for (a, b) in zip(segs, segs.dropFirst()) { XCTAssertEqual(a.y1, b.y0) }
    }
}
