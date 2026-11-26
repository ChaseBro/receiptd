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
        // The first-run coach is off unless a test turns it on (its dimming would skew screenshots).
        app.launchArguments += ["-booth.server", server, "-booth.count", "1", "-booth.sound", "NO", "-booth.coachDone", "YES"]
    }
    var base: [String] { ["-booth.server", server, "-booth.count", "1", "-booth.sound", "NO"] }

    /// No saved PIN and no bundled one (a Booth.local.xcconfig PIN is ignored): the lock screen.
    func launchLocked() {
        app.launchArguments += ["-booth.pin", "", "-booth.ignoreBundledPin", "YES"]
        app.launch()
    }

    func shot(_ name: String) { save(XCUIScreen.main.screenshot(), name) }
    func save(_ s: XCUIScreenshot, _ name: String) {
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let dir = ProcessInfo.processInfo.environment["BOOTH_SHOTS"] {
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }

    func testUnlockShootReviewPrint() {
        app.launchArguments += ["-booth.shots", "3", "-booth.coachDone", "YES"]
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

        // three shots (asked for: the default is one), countdown 1 s each
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

    /// A saved PIN opens straight to the camera; "share the booth" (beside the themes + settings) shows the PIN, both links + QR codes.
    func testSavedPinOpensCameraAndShares() {
        app.launchArguments += ["-booth.pin", "1234"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.secureTextFields["PIN"].exists, "no lock screen with a PIN")
        // The small phone-with-plus (end of the theme bar) opens the "share the booth" sheet when held: the PIN, QR codes + share buttons.
        let booth = app.buttons["Share the booth"]
        booth.tap()
        XCTAssertEqual(app.staticTexts["adultHint"].label, "Hold to share the booth", "a tap only shows the hint")
        XCTAssertFalse(app.staticTexts["boothPin"].exists)
        booth.press(forDuration: 1.6)
        XCTAssert(app.descendants(matching: .any)["QR code: Booth on the web"].waitForExistence(timeout: 5))
        let pinText = app.staticTexts["boothPin"]
        XCTAssert(pinText.exists, "the sheet shows the PIN")
        XCTAssert(pinText.label.contains("1234"), pinText.label)
        XCTAssert(app.buttons["Copy PIN"].exists)
        XCTAssert(app.staticTexts["This lets them use your booth (prints, photos)."].exists)
        XCTAssert(app.staticTexts["shareIntro"].label.contains("use their own phone as a booth too"), app.staticTexts["shareIntro"].label)
        XCTAssert(app.navigationBars["Share the booth"].exists)
        XCTAssert(app.descendants(matching: .any)["QR code: Booth app (TestFlight)"].exists)
        XCTAssert(app.buttons["Send link: Booth app (TestFlight)"].exists)
        sleep(1)
        shot("6-camera-share-sheet")
        app.buttons["Done"].tap()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 5))
        shot("6-camera-share-button")
        // Adult settings: press and hold the gear (camera, top-right).
        app.buttons["Settings"].press(forDuration: 1.6)
        XCTAssert(app.navigationBars["Booth settings"].waitForExistence(timeout: 5))
        let web = app.buttons["Booth on the web"]
        for _ in 0..<6 where !web.isHittable { app.swipeUp() }   // the Form is lazy: scroll to the section
        sleep(1)   // let the scroll settle (a tap during deceleration only stops it)
        XCTAssert(web.waitForExistence(timeout: 5))
        XCTAssert(app.buttons["Booth app (TestFlight)"].exists)
        shot("7-settings-share")
        app.buttons["Share the booth: PIN and QR codes"].tap()
        let qr = app.descendants(matching: .any)["QR code: Booth on the web"]
        _ = qr.waitForExistence(timeout: 5)
        shot("8-settings-share-qr")
        XCTAssert(qr.exists)
        XCTAssert(app.descendants(matching: .any)["QR code: Booth app (TestFlight)"].exists)
        XCTAssert(app.staticTexts["boothPin"].label.contains("1234"))
    }

    /// The settings gear: a tap shows "Hold to open settings" (and settings stay shut); held through
    /// the ring, settings open. Screenshots: camera at rest, the hint, the hold in progress, settings.
    func testGearTapHintsHoldOpens() {
        app.launchArguments += ["-booth.pin", "1234", "-booth.icons", "drawn"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        let gear = app.buttons["Settings"]
        XCTAssert(gear.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["adultHint"].exists, "no words at rest")
        let side = gear.frame.width
        XCTAssert(side >= 40 && side <= 72, "gear \(side) pt")
        sleep(2)
        shot("r1-camera-rest-drawn")
        gear.tap()
        let hint = app.staticTexts["adultHint"]
        XCTAssert(hint.waitForExistence(timeout: 2))
        XCTAssertEqual(hint.label, "Hold to open settings")
        shot("r2-gear-tap-hint")
        XCTAssertFalse(app.navigationBars["Booth settings"].exists, "a tap doesn't open settings")
        XCTAssert(hint.waitForNonExistence(timeout: 4), "the hint fades by itself")
        // Mid-hold screenshot from another thread while the press runs (the ring + "Keep holding…").
        let midHold = expectation(description: "mid-hold shot")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.75) {
            let s = XCUIScreen.main.screenshot()
            DispatchQueue.main.async { self.save(s, "r3-gear-holding"); midHold.fulfill() }
        }
        gear.press(forDuration: 1.7)
        wait(for: [midHold], timeout: 5)
        XCTAssert(app.navigationBars["Booth settings"].waitForExistence(timeout: 5), "held: settings open")
        sleep(1)
        shot("r4-settings-top")
        XCTAssert(app.descendants(matching: .any)["statusTiles"].exists)
        for _ in 0..<8 { app.swipeUp() }
        sleep(1)
        shot("r5-settings-bottom")
    }

    /// The local booth has no printer polling it, so it is offline: the drawn badge shows; a tap
    /// gives the adult label, any other touch dismisses it.
    func testPrinterOfflineBadgeAndLabel() {
        app.launchArguments += ["-booth.pin", "1234", "-booth.icons", "drawn"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        let badge = app.buttons["printerBadge"]
        XCTAssert(badge.waitForExistence(timeout: 10))
        XCTAssertEqual(badge.value as? String, "offline")
        XCTAssertEqual(badge.label, "Printer offline")
        XCTAssertFalse(app.staticTexts["adultHint"].exists, "no label until tapped")
        sleep(1)
        shot("r6-printer-offline-badge")
        badge.tap()
        let hint = app.staticTexts["adultHint"]
        XCTAssert(hint.waitForExistence(timeout: 2))
        XCTAssert(hint.label.hasPrefix("Printer offline · "), hint.label)
        XCTAssert(hint.label.hasSuffix("Check its power & Wi-Fi"), hint.label)
        shot("r7-printer-offline-label")
        app.buttons["Switch camera"].tap()   // any other touch
        XCTAssert(hint.waitForNonExistence(timeout: 2), "another touch dismisses the label")
    }

    /// Icon style Classic: today's emoji. (Drawn is the default.) Screenshots for both.
    func testClassicIcons() {
        app.launchArguments += ["-booth.pin", "1234", "-booth.icons", "classic"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        XCTAssert(app.buttons["Settings"].exists)
        sleep(2)
        shot("r8-camera-rest-classic")
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

    /// The camera stage is the photo slot's shape (upright portrait frames: 4:5; landscape iPad: 4:3),
    /// fitted and centred, portrait and landscape; the live dots fill it. Share the booth sits off the
    /// camera window, clear of the themes' scroll, the gear and the tray. Screenshots per device.
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
            if (app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height) != (o == .landscapeRight) {
                // Some Simulators ignore a turn while the app runs: relaunch already turned.
                app.terminate(); XCUIDevice.shared.orientation = o; sleep(2); app.launch()
                XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10)); sleep(3)
            }
            // Name the shot after what the window really is (a Simulator may ignore the turn).
            let w = app.windows.firstMatch.frame, name = w.width > w.height ? "landscape" : "portrait"
            print("stage-shape asked \(asked): window \(w)")
            let dots = app.descendants(matching: .any)["livePreview"]
            XCTAssert(dots.waitForExistence(timeout: 10))
            let f = dots.frame
            XCTAssertEqual(f.width / f.height, name == "portrait" ? 4.0 / 5 : 4.0 / 3, accuracy: 0.02, "\(name): stage \(f)")
            let share = app.buttons["Share the booth"]
            XCTAssert(share.isHittable, name)
            let sf = share.frame
            XCTAssertFalse(sf.intersects(f), "\(name): share the booth is off the camera window \(sf) vs \(f)")
            XCTAssertFalse(sf.intersects(app.buttons["Settings"].frame), "\(name): clear of the gear")
            XCTAssertFalse(sf.intersects(app.buttons["Take photo"].frame) || sf.intersects(app.buttons["Switch camera"].frame), "\(name): clear of the tray")
            // The theme picker's scroller (its buttons may run under its clipped edge; the scroller itself must not reach the sticker).
            let scroller = app.scrollViews.firstMatch
            XCTAssert(scroller.exists, "\(name): theme picker")
            XCTAssertFalse(sf.intersects(scroller.frame), "\(name): clear of the theme picker \(scroller.frame)")
            XCTAssert(app.windows.firstMatch.frame.contains(sf), "\(name): on screen")
            shot("11-stage-\(device)-\(name)")
        }
        XCUIDevice.shared.orientation = .portrait
    }

    // MARK: which way is up
    //
    // The Simulator's fake sensor (Camera.swift) delivers landscape frames turned the way a real
    // sensor sees the scene: an ink arrow pointing up (a wide head over a thin shaft, so the top half
    // is darker) and an ink block at the scene's right edge, mid height (shows mirroring). Those frames
    // go through the same rotation path as a device's. These tests read the screenshots back.

    struct Ink: CustomStringConvertible {
        var top = 0.0, bottom = 0.0, left = 0.0, right = 0.0, edgeLeft = 0.0, edgeRight = 0.0
        /// Dark top half / dark bottom half: > 1 for an arrow pointing up.
        var up: Double { top / max(bottom, 1) }
        /// Dark right half / dark left half: > 1 for an arrow pointing right.
        var pointsRight: Double { right / max(left, 1) }
        var description: String { String(format: "up %.2f, right %.2f, edge L %.0f R %.0f", up, pointsRight, edgeLeft, edgeRight) }
    }

    /// Dark pixels of `frame` (points) in `s`, inset 8 % (outlines, rounded corners), by half and by edge strip.
    func ink(_ s: XCUIScreenshot, _ frame: CGRect) -> Ink {
        let img = s.image
        // Draw through UIKit so the pixels are in screen orientation whatever the screenshot's EXIF says.
        let win = app.windows.firstMatch.frame
        let scale = img.size.width * img.scale / win.width   // screenshot pixels per point
        let r = frame.insetBy(dx: frame.width * 0.08, dy: frame.height * 0.08)
        let w = Int(r.width * scale), h = Int(r.height * scale)
        guard w > 8, h > 8 else { return Ink() }
        var px = [UInt8](repeating: 0, count: w * h * 4)
        let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        UIGraphicsPushContext(ctx)
        ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1)   // UIKit drawing is y-down
        img.draw(in: CGRect(x: -r.minX * scale, y: -r.minY * scale, width: win.width * scale, height: win.height * scale))
        UIGraphicsPopContext()
        var k = Ink()
        for y in 0..<h { for x in 0..<w {
            let i = (y * w + x) * 4
            let l = 0.2126 * Double(px[i]) + 0.7152 * Double(px[i + 1]) + 0.0722 * Double(px[i + 2])
            guard l < 100 else { continue }
            if y < h / 2 { k.top += 1 } else { k.bottom += 1 }
            if x > w * 12 / 100 && x < w * 88 / 100 { if x < w / 2 { k.left += 1 } else { k.right += 1 } }   // not the edge strips (marker)
            if y > h * 35 / 100 && y < h * 65 / 100 {
                if x < w * 12 / 100 { k.edgeLeft += 1 } else if x > w * 88 / 100 { k.edgeRight += 1 }
            }
        } }
        return k
    }

    /// The arrow points up and the edge block is on `marker`'s side ("left" = mirrored).
    func assertUpright(_ k: Ink, marker: String, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        print("orientation \(what): \(k)")
        let a = XCTAttachment(string: "\(what): \(k)"); a.lifetime = .keepAlways; add(a)
        XCTAssertGreaterThan(k.up, 1.25, "\(what): the arrow points up (\(k))", file: file, line: line)
        XCTAssertLessThan(abs(k.pointsRight - 1), 0.25, "\(what): not turned sideways (\(k))", file: file, line: line)
        if marker == "right" { XCTAssertGreaterThan(k.edgeRight, k.edgeLeft * 2 + 20, "\(what): unmirrored (\(k))", file: file, line: line) }
        else { XCTAssertGreaterThan(k.edgeLeft, k.edgeRight * 2 + 20, "\(what): mirrored (\(k))", file: file, line: line) }
    }

    func shotDir(_ sub: String) -> String? {
        ProcessInfo.processInfo.environment["BOOTH_SHOTS"].map { d in
            let u = URL(fileURLWithPath: d).appendingPathComponent(sub); try? FileManager.default.createDirectory(at: u, withIntermediateDirectories: true); return u.path
        }
    }
    func shotTo(_ sub: String, _ name: String) -> XCUIScreenshot {
        let s = XCUIScreen.main.screenshot()
        let a = XCTAttachment(screenshot: s); a.name = name; a.lifetime = .keepAlways; add(a)
        if let d = shotDir(sub) { try? s.pngRepresentation.write(to: URL(fileURLWithPath: d).appendingPathComponent("\(name).png")) }
        return s
    }

    /// Portrait (upright phone / iPad): the plain preview, the live dots and the captured photo in the
    /// review strip all show the arrow pointing up; the selfie preview is mirrored, the photo isn't;
    /// the stage is the 4:5 portrait slot.
    func testUpIsUpPortrait() { upIsUpPortrait(fake: "classic", dir: "orient-2") }

    /// The fake front camera's data output pre-rotates every buffer 180° and keeps it (AVCaptureSession.h:
    /// the default on the Spring 2024 iPads' front camera): the booth must allow for it, not assume 0°.
    func testUpIsUpConnectionRotated() { upIsUpPortrait(fake: "connection180", dir: "orient-2") }

    /// A front camera upright with the port at the bottom (AVCaptureDevice.h: "some cameras are upright
    /// when the device is held with the port on the bottom"): portrait buffers, 0° to stand up.
    func testUpIsUpPortraitNativeSensor() { upIsUpPortrait(fake: "portraitNative", dir: "orient-2") }

    func upIsUpPortrait(fake: String, dir: String) {
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
        let tag = fake == "classic" ? device : "\(device)-\(fake)"
        XCUIDevice.shared.orientation = .portrait
        let base = app.launchArguments + ["-booth.pin", "1234", "-booth.shots", "1", "-booth.mirror", "YES", "-booth.fakeCamera", fake]
        app.launchArguments = base + ["-booth.livePreview", "NO"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        let plain = app.descendants(matching: .any)["cameraPreview"]
        XCTAssert(plain.waitForExistence(timeout: 10))
        sleep(2)
        XCTAssertEqual(plain.frame.width / plain.frame.height, 4.0 / 5, accuracy: 0.03, "portrait stage: 4:5 \(plain.frame)")
        var s = shotTo(dir, "\(tag)-portrait-1-plain-preview")
        assertUpright(ink(s, plain.frame), marker: "left", "\(tag) plain preview (selfie, mirrored)")

        // Live print preview on (settings → Booth): the same frames, dithered.
        app.terminate()
        app.launchArguments = base + ["-booth.livePreview", "YES"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        let dots = app.descendants(matching: .any)["livePreview"]
        XCTAssert(dots.waitForExistence(timeout: 10))
        wait(for: [expectation(for: NSPredicate(format: "value CONTAINS ' fps'"), evaluatedWith: dots)], timeout: 15)
        sleep(2)
        XCTAssertEqual(dots.frame.width / dots.frame.height, 4.0 / 5, accuracy: 0.03, "portrait stage: 4:5 \(dots.frame)")
        s = shotTo(dir, "\(tag)-portrait-2-live-preview")
        assertUpright(ink(s, dots.frame), marker: "left", "\(tag) live dots (selfie, mirrored)")

        // Capture → review: the photo on the strip is upright and unmirrored.
        app.buttons["Take photo"].tap()
        XCTAssert(app.buttons["Print"].waitForExistence(timeout: 30))
        let photo = app.descendants(matching: .any)["reviewPhoto1"]
        XCTAssert(photo.waitForExistence(timeout: 10))
        sleep(1)
        XCTAssertLessThan(photo.frame.width / photo.frame.height, 1, "a portrait photo slot \(photo.frame)")
        s = shotTo(dir, "\(tag)-portrait-3-review")
        assertUpright(ink(s, photo.frame), marker: "right", "\(tag) review photo (unmirrored)")
    }

    /// A rotation-locked iPhone (the app is portrait-only) held sideways: the photo is upright to
    /// gravity (a landscape 4:3 slot), the stage shows that crop turned to the screen (3:4), and the
    /// mirrored preview still reads as "up" to the person holding the phone (on screen: pointing right).
    func testUpIsUpPhoneHeldSideways() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "the iPad turns its interface: covered by testStageShape")
        app.launchArguments += ["-booth.pin", "1234", "-booth.livePreview", "YES", "-booth.shots", "1", "-booth.mirror", "YES"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        XCUIDevice.shared.orientation = .landscapeLeft   // Home button on the right; the UI stays portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        sleep(3)
        let dots = app.descendants(matching: .any)["livePreview"]
        XCTAssert(dots.waitForExistence(timeout: 10))
        XCTAssertEqual(dots.frame.width / dots.frame.height, 3.0 / 4, accuracy: 0.03, "landscape slot turned to a portrait screen \(dots.frame)")
        let cam = app.descendants(matching: .any)["cameraPreview"]
        XCTAssertEqual(cam.value as? String, "capture 180, preview 90", "front camera, Home button right: capture from gravity, preview from the portrait UI")
        var s = shotTo("orient-2", "iphone-sideways-1-live-preview")
        var k = ink(s, dots.frame)
        print("orientation iphone sideways live: \(k)")
        XCTAssertGreaterThan(k.pointsRight, 1.25, "held sideways (top to the left): on screen the arrow points right = up for the holder (\(k))")
        app.buttons["Take photo"].tap()
        XCTAssert(app.buttons["Print"].waitForExistence(timeout: 30))
        let photo = app.descendants(matching: .any)["reviewPhoto1"]
        XCTAssert(photo.waitForExistence(timeout: 10))
        sleep(1)
        s = shotTo("orient-2", "iphone-sideways-2-review")
        XCTAssertGreaterThan(photo.frame.width / photo.frame.height, 1, "a landscape photo slot \(photo.frame)")
        k = ink(s, photo.frame)
        assertUpright(k, marker: "right", "iphone sideways review photo")
    }

    /// Settings → About this booth: version, camera, coordinator, angles, buffer sizes, orientations.
    func testAboutThisBoothDiagnostics() {
        app.launchArguments += ["-booth.pin", "1234", "-booth.livePreview", "YES"]
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        sleep(2)
        app.buttons["Settings"].press(forDuration: 1.7)
        XCTAssert(app.navigationBars["Booth settings"].waitForExistence(timeout: 5))
        let diag = app.descendants(matching: .any)["cameraDiagnostics"]
        for _ in 0..<12 where !(diag.exists && diag.isHittable) { app.swipeUp() }
        XCTAssert(diag.waitForExistence(timeout: 5))
        app.swipeUp(); sleep(2)
        let text = diag.label
        print("about this booth: \(text)")
        for want in ["App", "Camera", "Rotation coordinator", "Capture angle", "Preview angle", "Raw buffer", "Upright frame", "Interface orientation", "Device orientation"] {
            XCTAssert(text.contains(want), "shows \(want): \(text)")
        }
        XCTAssert(text.contains("On the camera screen"), "the camera-screen snapshot: \(text)")
        _ = shotTo("orient-2", "about-this-booth")
    }

    // MARK: first-run coach

    /// A device that never printed: the pointing hand pokes the shutter, then Print (not share-this-
    /// photo); once a print went out it doesn't come back, this visit or the next launch.
    func testFirstRunCoach() {
        app.launchArguments = base + ["-booth.pin", "1234", "-booth.shots", "1", "-booth.coachDone", "NO"]
        app.launch()
        let shutter = app.buttons["Take photo"]
        XCTAssert(shutter.waitForExistence(timeout: 10))
        let hand = app.descendants(matching: .any)["coachHand"]
        XCTAssert(hand.waitForExistence(timeout: 5), "fresh device: the hand shows")
        XCTAssertEqual(hand.value as? String, "shutter")
        XCTAssertEqual(hand.frame.midX, shutter.frame.midX, accuracy: 6, "over the shutter \(hand.frame) vs \(shutter.frame)")
        XCTAssertLessThan(hand.frame.maxY, shutter.frame.midY, "above it, pointing down")
        sleep(1); _ = shotTo("coach", "1-camera-hand-on-shutter")
        shutter.tap()
        XCTAssert(hand.waitForNonExistence(timeout: 3), "gone for the countdown + flash")
        let printBtn = app.buttons["Print"]
        XCTAssert(printBtn.waitForExistence(timeout: 30))
        XCTAssert(hand.waitForExistence(timeout: 10), "review: the hand again")
        XCTAssertEqual(hand.value as? String, "print")
        XCTAssertEqual(hand.frame.midX, printBtn.frame.midX, accuracy: 6, "over Print \(hand.frame) vs \(printBtn.frame)")
        sleep(1); _ = shotTo("coach", "2-review-hand-on-print")
        printBtn.tap()
        XCTAssert(hand.waitForNonExistence(timeout: 3))
        // The local booth takes the job (no printer polls): back to the camera by hand.
        sleep(3)
        XCTAssertFalse(app.buttons["Try again"].exists, "the print request went out")
        app.terminate()
        app.launchArguments = base + ["-booth.pin", "1234", "-booth.shots", "1"]   // the app's own saved "done"
        app.launch()
        XCTAssert(app.buttons["Take photo"].waitForExistence(timeout: 10))
        sleep(2)
        XCTAssertFalse(app.descendants(matching: .any)["coachHand"].exists, "after a print: no hand")
        _ = shotTo("coach", "3-camera-after-print")
    }

    // MARK: bundled PIN, fresh install

    /// A build with a bundled PIN (Booth.local.xcconfig BOOTH_PIN = 1234 for the local booth), no saved
    /// PIN: opens straight to the camera, shoots, prints (no error face), and the session reaches the
    /// local booth's archive with its originals, the strip and printed: true. Skipped without a bundled PIN.
    func testBundledPinShootPrintArchive() throws {
        let start = Date()
        app.launchArguments = base + ["-booth.pin", "", "-booth.shots", "1", "-booth.coachDone", "YES"]
        app.launch()
        let shutter = app.buttons["Take photo"]
        if !shutter.waitForExistence(timeout: 10) {
            throw XCTSkip("no bundled PIN in this build (lock screen): build with a Booth.local.xcconfig BOOTH_PIN for the local booth")
        }
        sleep(2)
        shutter.tap()
        let printBtn = app.buttons["Print"]
        XCTAssert(printBtn.waitForExistence(timeout: 30))
        sleep(1)
        printBtn.tap()
        XCTAssert(app.buttons["Retake"].waitForNonExistence(timeout: 5))
        sleep(4)
        _ = shotTo("bundled-pin", "printing")
        XCTAssertFalse(app.buttons["Try again"].exists, "print accepted (no 😕 + retry)")
        XCTAssertFalse(app.secureTextFields["PIN"].exists, "not bounced to the lock screen")
        // The archive: poll the local booth's /api/photos for a session from this test.
        var ny = Calendar(identifier: .gregorian); ny.timeZone = TimeZone(identifier: "America/New_York")!
        let c = ny.dateComponents([.year, .month, .day], from: start)
        let day = String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
        var found: [String: Any]?
        for _ in 0..<45 where found == nil {
            var req = URLRequest(url: URL(string: "\(server)/api/photos?day=\(day)")!)
            req.setValue("1234", forHTTPHeaderField: "x-booth-pin")
            let done = expectation(description: "photos")
            URLSession.shared.dataTask(with: req) { data, _, _ in
                defer { done.fulfill() }
                guard let data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let ss = o["sessions"] as? [[String: Any]] else { return }
                found = ss.first { s in
                    guard let id = s["id"] as? String, let t = Int(id.split(separator: "-")[0], radix: 36), Double(t) / 1000 >= start.timeIntervalSince1970 - 5 else { return false }
                    let files = s["files"] as? [String: Any] ?? [:], meta = s["meta"] as? [String: Any] ?? [:]
                    return files["orig-1.jpg"] != nil && files["strip.png"] != nil && meta["printed"] as? Bool == true
                }
            }.resume()
            wait(for: [done], timeout: 10)
            if found == nil { sleep(2) }
        }
        print("bundled-pin archive: \(found.map { "\($0["id"] ?? "?") \(($0["files"] as? [String: Any])?.keys.sorted() ?? [])" } ?? "none")")
        XCTAssertNotNil(found, "the session reached the archive with orig-1.jpg + strip.png, printed")
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
        XCTAssertFalse(app.buttons["Share the booth"].exists, "no share-the-booth without a PIN")
    }
}
