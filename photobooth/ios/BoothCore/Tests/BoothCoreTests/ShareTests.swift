import XCTest
@testable import BoothCore

/// Share links (Settings → Share booth) and the setup links the app opens.
final class ShareTests: XCTestCase {
    let server = URL(string: "https://booth.receiptd.sh")!

    func testWebLink() {
        XCTAssertEqual(BoothLinks.web(server: server, pin: "1234").absoluteString, "https://booth.receiptd.sh/#pin=1234")
        XCTAssertEqual(BoothLinks.web(server: URL(string: "https://booth.receiptd.sh/party.html?x=1")!, pin: "1234").absoluteString,
                       "https://booth.receiptd.sh/#pin=1234")
        XCTAssertEqual(BoothLinks.web(server: server, pin: "a&b=c d#%+").absoluteString,
                       "https://booth.receiptd.sh/#pin=a%26b%3Dc%20d%23%25%2B")
    }

    func testWordPinLinks() {
        // A word / phrase PIN: case and inner spaces kept exactly, URL-encoded in both links.
        XCTAssertEqual(BoothLinks.web(server: server, pin: "Gobble Gobble").absoluteString, "https://booth.receiptd.sh/#pin=Gobble%20Gobble")
        XCTAssertEqual(BoothLinks.app(server: server, pin: "Gobble Gobble").absoluteString,
                       "https://join.receiptd.sh/booth?k=_Txpzn6Mg2mI#server=https://booth.receiptd.sh&key=Gobble%20Gobble")
        XCTAssertEqual(Pairing(url: URL(string: "booth://setup#server=https://booth.receiptd.sh&key=%20Gobble%20Gobble%20")!)?.key, "Gobble Gobble", "ends trimmed")
    }

    func testAppLink() {
        let u = BoothLinks.app(server: server, pin: "1234")
        XCTAssertEqual(u.absoluteString, "https://join.receiptd.sh/booth?k=_Txpzn6Mg2mI#server=https://booth.receiptd.sh&key=1234")
        XCTAssertEqual(URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "_Txpzn6Mg2mI")
    }

    func testPairingParsesJoinLink() throws {
        let p = try XCTUnwrap(Pairing(url: URL(string: "https://join.receiptd.sh/booth?k=abc#server=https://booth.receiptd.sh&key=1234")!))
        XCTAssertEqual(p.server, server)
        XCTAssertEqual(p.key, "1234")
    }

    func testPairingParsesSetupLink() throws {
        let p = try XCTUnwrap(Pairing(url: URL(string: "booth://setup#server=https://booth.receiptd.sh&key=1234")!))
        XCTAssertEqual(p.server, server)
        XCTAssertEqual(p.key, "1234")
    }

    func testRoundTrip() throws {
        for pin in ["1234", "a&b=c d#%+", "ünï", "Gobble Gobble", "turkey-pie 2026"] {   // word / phrase PINs too
            let p = try XCTUnwrap(Pairing(url: BoothLinks.app(server: server, pin: pin)), pin)
            XCTAssertEqual(p.server, server)
            XCTAssertEqual(p.key, pin)
        }
        let local = URL(string: "https://booth.local:8443/x")!
        XCTAssertEqual(Pairing(url: BoothLinks.app(server: local, pin: "9"))?.server.absoluteString, "https://booth.local:8443")
    }

    func testPairingRejects() {
        for s in ["https://join.receiptd.sh/booth?k=abc",                                    // no fragment (plain sign-up)
                  "https://join.receiptd.sh/other?k=abc#server=https://booth.receiptd.sh",    // another app's join link
                  "https://evil.example/booth#server=https://booth.receiptd.sh&key=1",        // another host
                  "booth://setup#server=http://booth.receiptd.sh&key=1",                     // not https
                  "booth://setup#key=1"] {
            XCTAssertNil(Pairing(url: URL(string: s)!), s)
        }
        XCTAssertNil(Pairing(url: URL(string: "booth://setup#server=https://booth.receiptd.sh&key=")!)?.key)
        XCTAssertEqual(Pairing(url: URL(string: "booth://setup#server=http://localhost:8788&key=1234")!)?.server.port, 8788)   // local dev
    }
}
