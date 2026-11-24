// The kid flow end to end in the Simulator (test-pattern camera), against a
// local booth: `npm run dev:e2e` in photobooth/ (PIN 1234). Screenshots are
// attached to the test result and written to $BOOTH_SHOTS when set.
//
//   xcodebuild test -project PhotoBooth.xcodeproj -scheme PhotoBoothUITests \
//     -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M4)'

import XCTest

final class BoothFlowUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() {
        continueAfterFailure = false
        app.launchArguments += ["-booth.server", ProcessInfo.processInfo.environment["BOOTH_SERVER"] ?? "http://localhost:8788",
                                "-booth.pin", "", "-booth.count", "1", "-booth.sound", "NO"]
    }

    func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["BOOTH_SHOTS"] {
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    func testUnlockShootReviewPrint() {
        app.launch()
        let pin = app.secureTextFields["PIN"]
        XCTAssert(pin.waitForExistence(timeout: 10))
        shot("1-lock")
        pin.tap(); pin.typeText("1234")
        app.buttons["Unlock"].tap()

        let shutter = app.buttons["Take photo"]
        XCTAssert(shutter.waitForExistence(timeout: 10))
        // The active party offers only its frames (5 Thanksgiving themes).
        XCTAssert(app.buttons["turkey theme"].waitForExistence(timeout: 10))
        XCTAssert(app.buttons["dino theme"].waitForNonExistence(timeout: 15), "party narrows the frames")
        app.buttons["feast theme"].tap()
        shot("2-camera")

        // three shots (default), countdown 1 s each
        shutter.tap()
        let printBtn = app.buttons["Print"]
        XCTAssert(printBtn.waitForExistence(timeout: 30))
        XCTAssert(app.buttons["Rotate photo"].firstMatch.waitForExistence(timeout: 10))
        sleep(2)
        shot("3-review")
        app.buttons["More copies"].tap()
        XCTAssert(app.staticTexts["×2"].exists || app.otherElements["2 copies"].exists)

        printBtn.tap()
        XCTAssert(app.buttons["Retake"].waitForNonExistence(timeout: 5))
        sleep(1)
        shot("4-printing")
        // Local dev: no printer polls, so the job stays queued and the screen keeps
        // waiting. Give the request + the strip.png archive upload time to go out.
        sleep(12)
        shot("5-printing-later")
    }
}
