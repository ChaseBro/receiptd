import CoreImage
import XCTest
@testable import BoothCore

/// Which way is up: the angle → orientation mapping the camera, the live preview and grab() share.
final class OrientationTests: XCTestCase {
    func testNormalize() {
        XCTAssertEqual(Upright.normalize(0), 0)
        XCTAssertEqual(Upright.normalize(90), 90)
        XCTAssertEqual(Upright.normalize(89.6), 90)
        XCTAssertEqual(Upright.normalize(-90), 270)
        XCTAssertEqual(Upright.normalize(450), 90)
        XCTAssertEqual(Upright.normalize(.nan), 0)
    }

    func testOrientationTable() {
        XCTAssertEqual(Upright.orientation(0), .up)
        XCTAssertEqual(Upright.orientation(90), .right)
        XCTAssertEqual(Upright.orientation(180), .down)
        XCTAssertEqual(Upright.orientation(270), .left)
        XCTAssertEqual(Upright.orientation(-90), .left)
    }

    func testBuiltInAngles() {
        for front in [false, true] {
            XCTAssertEqual(Upright.builtInAngle(.portrait, front: front), 90, "portrait: a quarter turn for both cameras")
            XCTAssertEqual(Upright.builtInAngle(.portraitUpsideDown, front: front), 270)
        }
        XCTAssertEqual(Upright.builtInAngle(.landscapeRight, front: false), 0, "back sensor: native with the port on the right")
        XCTAssertEqual(Upright.builtInAngle(.landscapeLeft, front: false), 180)
        XCTAssertEqual(Upright.builtInAngle(.landscapeRight, front: true), 180, "front camera looks the other way")
        XCTAssertEqual(Upright.builtInAngle(.landscapeLeft, front: true), 0)
    }

    /// The angle table the app falls back on agrees with the geometric model of the hardware
    /// (SensorMount: which edge the sensor's top row faces, which way it looks), for every hold.
    func testBuiltInAnglesMatchTheHardwareModel() {
        for hold in Hold.allCases {
            XCTAssertEqual(Upright.builtInAngle(hold, front: false), SensorMount.back.horizonAngle(hold), "back, \(hold)")
            XCTAssertEqual(Upright.builtInAngle(hold, front: true), SensorMount.front.horizonAngle(hold), "front, \(hold)")
        }
        // A camera upright with the port at the bottom needs no turn held upright.
        XCTAssertEqual(SensorMount.frontPortraitNative.horizonAngle(.portrait), 0)
        XCTAssertEqual(SensorMount.frontPortraitNative.horizonAngle(.portraitUpsideDown), 180)
        XCTAssertFalse(SensorMount.frontPortraitNative.landscapeBuffer)
        // Front and back see landscape the other way round (they look in opposite directions).
        XCTAssertEqual(SensorMount.front.horizonAngle(.landscapeRight), 180)
        XCTAssertEqual(SensorMount.back.horizonAngle(.landscapeRight), 0)
    }

    func testFrameTurnAccountsForTheConnectionRotation() {
        XCTAssertEqual(Upright.frameTurn(capture: 90, buffer: 0), 90)
        // Spring 2024 iPads: the front camera's data output rotates buffers 180° by default.
        XCTAssertEqual(Upright.frameTurn(capture: 90, buffer: 180), 270)
        // A connection that already stood the buffer upright: no turn left to do.
        XCTAssertEqual(Upright.frameTurn(capture: 90, buffer: 90), 0)
        XCTAssertEqual(Upright.frameTurn(capture: 0, buffer: 270), 90)
    }

    func testSlotAndStage() {
        // Classic landscape buffer, upright phone: a quarter turn → portrait 4:5.
        XCTAssertTrue(Upright.uprightIsPortrait(buffer: (1920, 1440), turn: 90))
        XCTAssertFalse(Upright.uprightIsPortrait(buffer: (1920, 1440), turn: 180), "iPad landscape")
        // A buffer that is already portrait (pre-rotated, or a portrait-native camera): no turn → still portrait.
        XCTAssertTrue(Upright.uprightIsPortrait(buffer: (1440, 1920), turn: 0))
        XCTAssertFalse(Upright.uprightIsPortrait(buffer: (1440, 1920), turn: 90))
        XCTAssertTrue(Upright.uprightIsPortrait(buffer: nil, turn: 90), "no frame yet: assume a landscape sensor")
        XCTAssertEqual(Upright.uprightSize(1920, 1440, turn: 270).w, 1440)
        XCTAssertEqual(Upright.slotAspect(portrait: true), 0.8, accuracy: 1e-9, "upright phone: portrait 4:5")
        XCTAssertEqual(Upright.slotAspect(portrait: false), 4.0 / 3, accuracy: 1e-9)
        XCTAssertEqual(Upright.stageAspect(portrait: true, capture: 90, preview: 90), 0.8, accuracy: 1e-9)
        XCTAssertEqual(Upright.stageAspect(portrait: false, capture: 180, preview: 180), 4.0 / 3, accuracy: 1e-9, "iPad landscape")
        // A rotation-locked phone (portrait UI) held sideways: a landscape photo, seen turned on screen.
        XCTAssertEqual(Upright.stageAspect(portrait: false, capture: 0, preview: 90), 3.0 / 4, accuracy: 1e-9)
        XCTAssertEqual(Upright.displayTurn(capture: 0, preview: 90), 90)
        XCTAssertEqual(Upright.displayTurn(capture: 180, preview: 90), 270)
        XCTAssertEqual(Upright.displayTurn(capture: 90, preview: 90), 0)
    }

    /// A sensor frame built by index maths (the upright scene turned counter-clockwise by `angle`,
    /// as a real sensor sees it) comes out pixel-identical to the scene through `CIImage.oriented`.
    func testOrientedTurnsSensorFramesUpright() throws {
        let W = 6, H = 4
        // The upright scene: every pixel distinct (so any turn or flip is caught).
        let scene: [UInt8] = (0..<(W * H)).map { UInt8($0 * 9 + 7) }
        for angle in [0, 90, 180, 270] {
            let (sw, sh) = Upright.isQuarter(angle) ? (H, W) : (W, H)
            var sensor = [UInt8](repeating: 0, count: W * H)
            for y in 0..<H { for x in 0..<W {
                // Turn the scene counter-clockwise by `angle` (y down, like the buffer).
                let (sx, sy): (Int, Int)
                switch angle {
                case 90: (sx, sy) = (y, W - 1 - x)
                case 180: (sx, sy) = (W - 1 - x, H - 1 - y)
                case 270: (sx, sy) = (H - 1 - y, x)
                default: (sx, sy) = (x, y)
                }
                sensor[sy * sw + sx] = scene[y * W + x]
            } }
            let up = try render(CIImage(cgImage: gray(sensor, sw, sh)).oriented(Upright.orientation(angle)))
            XCTAssertEqual(up.w, W, "\(angle)°"); XCTAssertEqual(up.h, H, "\(angle)°")
            XCTAssertEqual(up.px, scene, "\(angle)°: upright")
        }
    }

    private func gray(_ px: [UInt8], _ w: Int, _ h: Int) -> CGImage {
        CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: CGDataProvider(data: Data(px) as CFData)!,
                decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    }

    private func render(_ img: CIImage) throws -> (w: Int, h: Int, px: [UInt8]) {
        let ctx = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
        let e = img.extent, w = Int(e.width), h = Int(e.height)
        let cg = try XCTUnwrap(ctx.createCGImage(img, from: e))
        var out = [UInt8](repeating: 0, count: w * h)
        let c = CGContext(data: &out, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w, space: CGColorSpaceCreateDeviceGray(),
                          bitmapInfo: CGImageAlphaInfo.none.rawValue)!
        c.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        return (w, h, out)
    }
}
