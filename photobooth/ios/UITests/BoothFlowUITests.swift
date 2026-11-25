// The kid flow end to end in the Simulator (test-pattern camera), against a
// local booth: `npm run dev:e2e` in photobooth/ (PIN 1234). Never point
// BOOTH_SERVER at production. Screenshots are
// attached to the test result and written to $BOOTH_SHOTS when set.
//
//   xcodebuild test -project PhotoBooth.xcodeproj -scheme PhotoBoothUITests \
//     -destination 'platform=iOS Simulator,name=iPad Air 11-inch (M4)'

import XCTest

final class BoothFlowUITests: XCTestCase {
    let app = XCUIApplication()

    let server = ProcessInfo.processInfo.environment["BOOTH_SERVER"] ?? "http://localhost:8788"

    override func setUp() {
        continueAfterFailure = false
        app.launchArguments += ["-booth.server", server, "-booth.count", "1", "-booth.sound", "NO"]
    }

    /// No saved PIN and no bundled one (a Booth.local.xcconfig PIN is ignored): the lock screen.
    func launchLocked() {
        app.launchArguments += ["-booth.pin", "", "-booth.ignoreBundledPin", "YES"]
        app.launch()
    }

    func shot(_ name: String) {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["BOOTH_SHOTS"] {
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    func testUnlockShootReviewPrint() {
        launchLocked()
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

    /// A saved PIN opens straight to the camera; settings → Share booth offers both links + QR codes.
    func testSavedPinOpensCameraAndShares() {
        app.launchArguments += ["-booth.pin", "1234"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.secureTextFields["PIN"].exists, "no lock screen with a PIN")
        // The camera screen's small 📤 sticker opens the share sheet (QR codes + share buttons).
        app.buttons["Share booth"].tap()
        XCTAssert(app.descendants(matching: .any)["QR code: Booth on the web"].waitForExistence(timeout: 5))
        XCTAssert(app.descendants(matching: .any)["QR code: Booth app (TestFlight)"].exists)
        XCTAssert(app.buttons["Send link: Booth app (TestFlight)"].exists)
        sleep(1)
        shot("6-camera-share-sheet")
        app.buttons["Done"].tap()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 5))
        shot("6-camera-share-button")
        // Adult settings: long-press the top-right corner for 1.5 s.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.02)).press(forDuration: 2)
        XCTAssert(app.navigationBars["Booth settings"].waitForExistence(timeout: 5))
        let web = app.buttons["Booth on the web"]
        for _ in 0..<6 where !web.isHittable { app.swipeUp() }   // the Form is lazy: scroll to the section
        sleep(1)   // let the scroll settle (a tap during deceleration only stops it)
        XCTAssert(web.waitForExistence(timeout: 5))
        XCTAssert(app.buttons["Booth app (TestFlight)"].exists)
        shot("7-settings-share")
        app.buttons["Show as QR codes"].tap()
        let qr = app.descendants(matching: .any)["QR code: Booth on the web"]
        _ = qr.waitForExistence(timeout: 5)
        shot("8-settings-share-qr")
        XCTAssert(qr.exists)
        XCTAssert(app.descendants(matching: .any)["QR code: Booth app (TestFlight)"].exists)
    }

    /// The camera stage shows the live print preview (the test pattern in printer dots); off in settings → plain video.
    func testLivePrintPreview() {
        app.launchArguments += ["-booth.pin", "1234", "-booth.livePreview", "YES"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        let dots = app.descendants(matching: .any)["livePreview"]
        XCTAssert(dots.waitForExistence(timeout: 10))
        let fps = NSPredicate(format: "value CONTAINS ' fps' AND NOT (value BEGINSWITH '0.0')")
        wait(for: [expectation(for: fps, evaluatedWith: dots)], timeout: 15)
        sleep(3)
        print("live print preview: \(dots.value ?? "")")
        let a = XCTAttachment(string: "live print preview: \(dots.value ?? "")"); a.lifetime = .keepAlways; add(a)
        shot("9-camera-live-preview")
    }

    /// Live print preview off: the plain test pattern, no dot layer.
    func testLivePrintPreviewOff() {
        app.launchArguments += ["-booth.pin", "1234", "-booth.livePreview", "NO"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        sleep(2)
        shot("9-camera-live-preview-off")
        let dots = app.descendants(matching: .any)["livePreview"]
        XCTAssertFalse(dots.exists && dots.isHittable, "hidden when off: \(dots.debugDescription)")
    }

    /// A setup link (the share link's fragment, as booth://) saves the PIN and lands on the camera.
    func testSetupLinkOpensCamera() {
        launchLocked()
        XCTAssert(app.secureTextFields["PIN"].waitForExistence(timeout: 10))
        app.open(URL(string: "booth://setup#server=\(server)&key=1234")!)
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.secureTextFields["PIN"].exists)
    }

    /// A wrong PIN (e.g. a bundled one the server rotated away from) falls back to the lock screen, once.
    func testRejectedPinShowsLock() {
        app.launchArguments += ["-booth.pin", "0000", "-booth.ignoreBundledPin", "YES"]
        app.launch()
        XCTAssert(app.secureTextFields["PIN"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Share booth"].exists, "no share button without a PIN")
    }
}
