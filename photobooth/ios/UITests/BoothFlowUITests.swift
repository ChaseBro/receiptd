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
        // Share this photo from the printing screen: the same "your photos" QR.
        app.buttons["Share this photo"].tap()
        XCTAssert(app.descendants(matching: .any)["QR code: Your photos"].waitForExistence(timeout: 10))
        shot("4b-printing-your-photos")
        app.buttons["Close"].tap()
        // Local dev: no printer polls, so the job stays queued and the screen keeps
        // waiting. Give the request + the strip.png archive upload time to go out.
        sleep(12)
        shot("5-printing-later")
    }

    /// A saved PIN opens straight to the camera; "make another booth" (top corner + settings) shows the PIN, both links + QR codes.
    func testSavedPinOpensCameraAndShares() {
        app.launchArguments += ["-booth.pin", "1234"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.secureTextFields["PIN"].exists, "no lock screen with a PIN")
        // The small phone-with-plus up top opens the "make another booth" sheet: the PIN, QR codes + share buttons.
        app.buttons["Make another booth"].tap()
        XCTAssert(app.descendants(matching: .any)["QR code: Booth on the web"].waitForExistence(timeout: 5))
        let pinText = app.staticTexts["boothPin"]
        XCTAssert(pinText.exists, "the sheet shows the PIN")
        XCTAssert(pinText.label.contains("1234"), pinText.label)
        XCTAssert(app.buttons["Copy PIN"].exists)
        XCTAssert(app.staticTexts["This lets them use your booth (prints, photos)."].exists)
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
        app.buttons["Show PIN and QR codes"].tap()
        let qr = app.descendants(matching: .any)["QR code: Booth on the web"]
        _ = qr.waitForExistence(timeout: 5)
        shot("8-settings-share-qr")
        XCTAssert(qr.exists)
        XCTAssert(app.descendants(matching: .any)["QR code: Booth app (TestFlight)"].exists)
        XCTAssert(app.staticTexts["boothPin"].label.contains("1234"))
    }

    /// Share this photo on the review screen (before printing): a "your photos" QR for this session's
    /// /s/<token> page on the local booth, and the share-files button. Kid surface: no words.
    func testSharePhotoQROnReview() {
        app.launchArguments += ["-booth.pin", "1234", "-booth.shots", "1"]
        app.launch()
        let shutter = app.buttons["Take photo"]
        XCTAssert(shutter.waitForExistence(timeout: 10))
        shutter.tap()
        XCTAssert(app.buttons["Print"].waitForExistence(timeout: 30))
        sleep(1)
        app.buttons["Share this photo"].tap()
        let qr = app.descendants(matching: .any)["QR code: Your photos"]
        XCTAssert(qr.waitForExistence(timeout: 10))
        let url = qr.value as? String ?? ""
        XCTAssert(url.hasPrefix(server + "/s/"), url)
        XCTAssert(app.buttons["Send photos"].exists)
        sleep(1)
        shot("10-review-your-photos")
        app.buttons["Close"].tap()
        XCTAssert(qr.waitForNonExistence(timeout: 5))
        XCTAssert(app.buttons["Print"].exists, "back on review")
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

    /// The camera stage is the photo slot's shape (the Simulator's test pattern is landscape: 4:3),
    /// fitted and centred, portrait and landscape; the live dots fill it. Screenshots per device.
    func testStageShape() {
        app.launchArguments += ["-booth.pin", "1234", "-booth.livePreview", "YES"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
        // iPhone is portrait-only (Info.plist); the iPad turns.
        let turns: [(String, UIDeviceOrientation)] = device == "ipad" ? [("portrait", .portrait), ("landscape", .landscapeRight)] : [("portrait", .portrait)]
        for (asked, o) in turns {
            XCUIDevice.shared.orientation = o
            sleep(4)
            // Name the shot after what the window really is (a Simulator may ignore the turn).
            let w = app.windows.firstMatch.frame, name = w.width > w.height ? "landscape" : "portrait"
            print("stage-shape asked \(asked): window \(w)")
            let dots = app.descendants(matching: .any)["livePreview"]
            XCTAssert(dots.waitForExistence(timeout: 10))
            let f = dots.frame
            XCTAssertEqual(f.width / f.height, 4.0 / 3, accuracy: 0.02, "\(name): stage \(f)")
            XCTAssert(app.buttons["Make another booth"].isHittable, name)
            shot("11-stage-\(device)-\(name)")
        }
        XCUIDevice.shared.orientation = .portrait
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
        XCTAssertFalse(app.buttons["Make another booth"].exists, "no make-another-booth without a PIN")
    }
}
