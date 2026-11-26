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

    func testStartCopiesMatchesWeb() {
        // public/copies.js startCopies (test/copies.test.mjs, same cases).
        XCTAssertEqual(START_COPIES, 1); XCTAssertEqual(KID_MAX_COPIES, 3)
        XCTAssertEqual(startCopies(nil), 1)
        XCTAssertEqual(startCopies([2, 1]), 2)
        XCTAssertEqual(startCopies([5]), 3)
        XCTAssertEqual(startCopies([5], start: 1, max: 6), 5)
        XCTAssertEqual(startCopies([1], start: 2, max: 3), 2)
        XCTAssertEqual(startCopies([0], start: 4, max: 3), 3)
        XCTAssertEqual(startCopies([9], start: 1, max: 99), 6)
        XCTAssertEqual(kidMax(0), 1); XCTAssertEqual(kidMax(12), 6)
    }

    /// The camera badge: each printer problem maps to its own state + drawing (public/printer-state.js).
    func testPrinterBadgeStates() throws {
        func h(_ json: String) throws -> PrinterHealth { try JSONDecoder().decode(PrinterHealth.self, from: Data(json.utf8)) }
        let ok = #""code":200,"text":"200 OK","paperOut":false,"paperLow":false,"coverOpen":false,"error":false"#
        XCTAssertEqual(try h("{\(ok),\"online\":true,\"lastSeenSec\":5}").state, .ready)
        XCTAssertEqual(try h("{\(ok),\"online\":false,\"lastSeenSec\":600}").state, .asleep, "stale lastSeen, no error = napping")
        XCTAssertEqual(try h(#"{"code":null,"text":"","paperOut":false,"paperLow":false,"coverOpen":false,"error":false,"online":false,"lastSeenSec":null}"#).state, .asleep, "never seen: napping until a nudge goes unanswered")
        XCTAssertEqual(try h("{\(ok),\"online\":false,\"lastSeenSec\":600}").state(wake: PrinterWake(failed: true)), .offline, "unanswered nudge = offline")
        XCTAssertEqual(try h(#"{"paperOut":true,"coverOpen":false,"error":false}"#).state, .paperOut, "no online field (old server): the code still wins")
        XCTAssertEqual(PrinterHealth(paperOut: true, online: false).state(wake: PrinterWake(failed: true)), .paperOut, "error codes win, even stale")
        XCTAssertEqual(PrinterHealth(code: 410, paperOut: true, online: true).state, .paperOut)
        XCTAssertEqual(PrinterHealth(code: 420, coverOpen: true, online: true).state, .coverOpen)
        XCTAssertEqual(PrinterHealth(code: 520, error: true, online: true).state, .error)
        XCTAssertEqual(PrinterHealth(code: 411, paperLow: true, online: true).state, .paperLow)
        XCTAssertEqual(Set(PrinterState.allCases.filter(\.needsAdult)), [.offline, .paperOut, .coverOpen, .error])
        XCTAssertEqual(PrinterState.allCases.filter(\.soft), [.asleep])
        XCTAssertEqual(Set(PrinterState.allCases.map(\.icon)).count, PrinterState.allCases.count, "one drawing per state")
        XCTAssertEqual(Set([PrinterState.offline, .paperOut, .coverOpen, .error].map(\.emoji)).count, 4, "Classic emoji distinct")
        // Adult labels.
        var cal = Calendar(identifier: .gregorian); cal.timeZone = TimeZone(identifier: "America/New_York")!
        let now = ISO8601DateFormatter().date(from: "2026-11-24T19:30:00Z")!   // 2:30 pm New York
        let failed = PrinterWake(failed: true)
        XCTAssertEqual(PrinterHealth(online: false, lastSeenSec: 960).hint(now: now, calendar: cal, wake: failed), "Printer offline · last seen 2:14 pm · Check its power & Wi-Fi")
        XCTAssertEqual(PrinterHealth(online: false).hint(now: now, calendar: cal, wake: failed), "Printer offline · not seen yet · Check its power & Wi-Fi")
        XCTAssertEqual(PrinterHealth(online: false, lastSeenSec: 7200).hint(), "Printer napping · last check-in 2h ago")
        XCTAssertEqual(PrinterHealth(online: false, lastSeenSec: 7200).hint(wake: PrinterWake(phase: .waking)), "Printer napping · waking it up…")
        XCTAssertEqual(PrinterHealth(paperOut: true, online: true).hint(), "Out of paper")
        XCTAssertEqual(PrinterHealth(coverOpen: true, online: true).hint(), "Cover open")
        XCTAssertEqual(PrinterHealth(error: true, online: true).hint(), "Printer error — turn it off and on")
    }

    /// printer-state.js wakeStep, same cases as test/printer-badge.test.mjs.
    func testPrinterWake() {
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        let stale = PrinterHealth(online: false, lastSeenSec: 7200), fresh = PrinterHealth(online: true, lastSeenSec: 5)
        var w = PrinterWake()
        var r = w.step(stale, now: t0, inUse: true)
        XCTAssertTrue(r.nudge); XCTAssertTrue(r.recheck); XCTAssertEqual(stale.state(wake: w), .asleep)
        r = w.step(stale, now: t0 + PrinterWake.recheck)
        XCTAssertFalse(r.nudge); XCTAssertTrue(r.recheck); XCTAssertEqual(stale.state(wake: w), .asleep)
        var ok = w; r = ok.step(fresh, now: t0 + 8)
        XCTAssertEqual(ok.phase, .idle); XCTAssertFalse(ok.failed); XCTAssertFalse(r.recheck); XCTAssertEqual(fresh.state(wake: ok), .ready)
        r = w.step(stale, now: t0 + PrinterWake.window)
        XCTAssertTrue(w.failed); XCTAssertFalse(r.recheck); XCTAssertFalse(r.nudge); XCTAssertEqual(stale.state(wake: w), .offline)
        XCTAssertFalse(w.step(stale, now: t0 + PrinterWake.window + 1).nudge, "cooldown")
        XCTAssertTrue(w.step(stale, now: t0 + PrinterWake.cooldown).nudge, "retries after the cooldown")
        XCTAssertEqual(stale.state(wake: w), .offline, "stays offline while re-waking")
        _ = w.step(fresh, now: t0 + PrinterWake.cooldown + 4); XCTAssertEqual(fresh.state(wake: w), .ready, "a check-in clears offline")
        var idle = PrinterWake(); XCTAssertFalse(idle.step(stale, now: t0, inUse: false).nudge, "not in use: no automatic nudge")
        var recent = PrinterWake(nudgedAt: t0 - 1); XCTAssertFalse(recent.step(stale, now: t0, inUse: true).nudge, "cooldown")
        recent = PrinterWake(nudgedAt: t0 - 1); XCTAssertTrue(recent.step(stale, now: t0, force: true).nudge, "force (print)")
        var f = PrinterWake(); XCTAssertFalse(f.step(fresh, now: t0, force: true).nudge, "fresh: never nudged")
        var e = PrinterWake(); _ = e.step(PrinterHealth(paperOut: true, online: false), now: t0)
        XCTAssertEqual(PrinterHealth(paperOut: true, online: false).state(wake: e), .paperOut)
        XCTAssertEqual(PrinterHealth(error: true, online: false).state(wake: PrinterWake(failed: true)), .error)
    }
}
