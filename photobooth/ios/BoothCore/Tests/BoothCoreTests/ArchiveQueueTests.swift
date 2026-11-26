import XCTest
@testable import BoothCore

/// Answers every request with `Stub401.status` and counts the PIN it carried.
final class Stub401: URLProtocol {
    nonisolated(unsafe) static var status = 401
    nonisolated(unsafe) static var pins: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Stub401.pins.append(request.value(forHTTPHeaderField: "x-booth-pin") ?? "")
        let res = HTTPURLResponse(url: request.url!, statusCode: Stub401.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Upload failures are surfaced (settings: "uploads failing"), and a 401 asks the app to re-check its PIN.
final class ArchiveQueueTests: XCTestCase {
    private func queue() -> (ArchiveQueue, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("aq-\(UUID().uuidString)")
        return (ArchiveQueue(root: root), root)
    }
    private func api(pin: String) -> BoothAPI {
        let cfg = URLSessionConfiguration.ephemeral; cfg.protocolClasses = [Stub401.self]
        return BoothAPI(server: URL(string: "https://booth.test")!, pin: pin, session: URLSession(configuration: cfg))
    }

    func testDescribe() {
        XCTAssertEqual(ArchiveQueue.describe(0), "network")
        XCTAssertEqual(ArchiveQueue.describe(401), "401 PIN rejected")
        XCTAssertEqual(ArchiveQueue.describe(503), "HTTP 503")
    }

    func testUpload401IsSurfacedAndReported() async throws {
        Stub401.status = 401; Stub401.pins = []
        let (q, root) = queue(); defer { try? FileManager.default.removeItem(at: root) }
        let locked = expectation(description: "onLocked")
        await q.setAPI(api(pin: "1234"))
        await q.setOnLocked { locked.fulfill() }
        await q.enqueue(ArchiveMeta(id: "mwxm0000-00000000"), files: ["orig-1.jpg": Data([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0])])
        await q.flush()
        await fulfillment(of: [locked], timeout: 5)
        let failure = await q.lastFailure
        XCTAssertEqual(failure, "401 PIN rejected")
        XCTAssertEqual(Stub401.pins, ["1234"], "the upload carried the PIN in use")
        let pending = await q.pending()
        XCTAssertEqual(pending.0, 1, "kept for after the re-unlock, not dropped")
    }

    func testNoPinIsSurfaced() async {
        let (q, root) = queue(); defer { try? FileManager.default.removeItem(at: root) }
        await q.setAPI(api(pin: ""))
        await q.enqueue(ArchiveMeta(id: "mwxm0001-00000000"), files: ["orig-1.jpg": Data(repeating: 1, count: 10)])
        await q.flush()
        let failure = await q.lastFailure
        XCTAssertEqual(failure, "no PIN")
    }
}
