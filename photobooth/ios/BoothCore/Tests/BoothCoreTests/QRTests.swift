import XCTest
@testable import BoothCore

/// Module-for-module parity with the web app's encoder (public/qr.js).
/// Regenerate the fixture with `node ios/parity/gen-qr.mjs` from photobooth/.
final class QRTests: XCTestCase {
    private struct Case: Decodable {
        let text: String
        let level: String
        let n: Int
        let rows: [String]
    }

    private func loadCases() throws -> [Case] {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "qr", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode([Case].self, from: Data(contentsOf: url))
    }

    func testMatchesWebEncoder() throws {
        let cases = try loadCases()
        XCTAssertGreaterThan(cases.count, 20)
        for k in cases {
            let m = QR.matrix(k.text, level: Character(k.level))
            XCTAssertEqual(m.n, k.n, "size for \(k.level) \(k.text.debugDescription)")
            guard m.n == k.n else { continue }
            var mismatches = 0
            for (r, row) in k.rows.enumerated() {
                for (c, ch) in row.utf8.enumerated() where m.dark(r, c) != (ch == UInt8(ascii: "1")) {
                    mismatches += 1
                }
            }
            XCTAssertEqual(mismatches, 0, "modules differ for \(k.level) \(k.text.debugDescription)")
        }
    }

    func testSide() {
        let url = "https://booth.receiptd.sh/a/abcdefghjkmn/mfx3k2a1-1a2b3c4d"
        let n = QR.matrix(url).n
        XCTAssertEqual(QR.side(url), (n + 8) * 5)
        XCTAssertEqual(QR.side(url, module: 3, quiet: 2), (n + 4) * 3)
    }
}
