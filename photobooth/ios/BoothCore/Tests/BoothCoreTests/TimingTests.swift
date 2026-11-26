import XCTest
@testable import BoothCore

/// Same cases as test/timing.test.mjs.
final class TimingTests: XCTestCase {
    func testCountdownDefaultsToInstant() {
        XCTAssertEqual(COUNTDOWN_DEFAULT, 0)
        XCTAssertEqual(clampCountdown(nil), 0, "fresh device: nothing stored")
        XCTAssertEqual(clampCountdown(3), 3, "a device that chose 3 s keeps it")
        XCTAssertEqual(clampCountdown(0), 0); XCTAssertEqual(clampCountdown(99), COUNTDOWN_MAX); XCTAssertEqual(clampCountdown(-2), 0)
    }

    func testShotCountdown() {
        XCTAssertEqual((0..<3).map { shotCountdown(0, shot: $0) }, [0, BETWEEN_SHOTS_S, BETWEEN_SHOTS_S])
        XCTAssertEqual((0..<3).map { shotCountdown(3, shot: $0) }, [3, 3, 3])
        XCTAssertEqual(BETWEEN_SHOTS_S, 1)
    }

    func testPrintingScreenNeverWaitsForThePrinter() {
        XCTAssertFalse(printScreenDone(elapsed: 0, status: nil))
        XCTAssertFalse(printScreenDone(elapsed: PRINT_BEAT - 0.01, status: "completed"), "a beat of animation even if it's instant")
        XCTAssertTrue(printScreenDone(elapsed: PRINT_BEAT, status: "completed"))
        XCTAssertFalse(printScreenDone(elapsed: PRINT_HOLD - 0.01, status: "queued"))
        XCTAssertTrue(printScreenDone(elapsed: PRINT_HOLD, status: "queued"), "still in line: leave anyway")
        XCTAssertTrue(printScreenDone(elapsed: PRINT_HOLD, status: nil), "no reply at all: leave anyway")
        XCTAssertLessThanOrEqual(PRINT_HOLD + CELEBRATE, 8)
    }

    func testFollowUpNudges() {
        XCTAssertEqual(followSeconds(copies: 1), 90); XCTAssertEqual(followSeconds(copies: 3), 150)
        XCTAssertFalse(nudgeDue(sinceSent: 5, nudges: 0, copies: 1, height: 1000))
        XCTAssertTrue(nudgeDue(sinceSent: 6.001, nudges: 0, copies: 1, height: 1000))
        XCTAssertFalse(nudgeDue(sinceSent: 6.001, nudges: 1, copies: 1, height: 1000))
        XCTAssertTrue(nudgeDue(sinceSent: 12.001, nudges: 1, copies: 1, height: 1000))
        XCTAssertFalse(nudgeDue(sinceSent: 1e9, nudges: 5, copies: 1, height: 1000), "at most 5")
        XCTAssertFalse(nudgeDue(sinceSent: 6.001, nudges: 0, copies: 2, height: 1000), "extra copies add their print time")
    }
}
