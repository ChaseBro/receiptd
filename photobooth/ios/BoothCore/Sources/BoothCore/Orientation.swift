// Camera orientation: the one place that says which way is up.
//
// Built-in cameras deliver frames in the sensor's native landscape orientation. AVFoundation's
// rotation coordinator reports two clockwise angles that turn such a frame level with the horizon:
// one for *capture* (photos: from gravity) and one for *preview* (the on-screen view: from the
// interface orientation of the layer showing it). The booth applies
//   - the capture angle to every grabbed photo and to the live print preview's frames before the
//     slot crop + dither (so the live dots are exactly the print), and
//   - the difference (preview − capture) to show those dots lined up with the plain video,
// and takes the photo slot's shape (4:3 / 4:5) from the capture angle, turned to screen space for
// the camera stage (`stageAspect`).
//
// `builtInAngle` is what a built-in iPhone / iPad camera reports for a given orientation (the back
// sensor is native with the Home button / port on the right, the front one with it on the left).
// The app uses it before the coordinator is ready, and the Simulator's fake camera uses it to emit
// sensor-shaped frames, so both go through exactly the same rotation path as a real device.

import CoreGraphics
import ImageIO

/// Device or interface orientation, named like `UIInterfaceOrientation` (landscapeRight = the Home
/// button / port on the right). `UIDeviceOrientation.landscapeLeft` is `.landscapeRight` here.
public enum Hold: String, CaseIterable, Sendable {
    case portrait, portraitUpsideDown, landscapeLeft, landscapeRight
}

public enum Upright {
    /// Clockwise degrees → 0, 90, 180 or 270.
    public static func normalize(_ angle: Double) -> Int {
        guard angle.isFinite else { return 0 }
        let q = Int((angle / 90).rounded()) * 90
        return ((q % 360) + 360) % 360
    }

    /// Clockwise degrees → the orientation that turns a sensor frame upright by them
    /// (`CIImage.oriented(_:)`; EXIF 1 / 6 / 3 / 8).
    public static func orientation(_ angle: Int) -> CGImagePropertyOrientation {
        switch normalize(Double(angle)) {
        case 90: return .right
        case 180: return .down
        case 270: return .left
        default: return .up
        }
    }

    /// A quarter turn (90° / 270°) of a landscape sensor frame: the upright frame is portrait.
    public static func isQuarter(_ angle: Int) -> Bool { normalize(Double(angle)) % 180 == 90 }

    /// What a built-in camera's rotation coordinator reports, held `hold` (gravity for capture, the
    /// interface orientation for preview). Portrait is 90° for both cameras; in landscape they differ
    /// by 180° because the front camera looks the other way.
    public static func builtInAngle(_ hold: Hold, front: Bool) -> Int {
        switch hold {
        case .portrait: return 90
        case .portraitUpsideDown: return 270
        case .landscapeRight: return front ? 180 : 0
        case .landscapeLeft: return front ? 0 : 180
        }
    }

    /// The photo slot's aspect (width / height) for upright frames: 4:5 portrait, 4:3 landscape
    /// (frames.js slotAspect).
    public static func slotAspect(capture: Int) -> Double { isQuarter(capture) ? 4.0 / 5 : 4.0 / 3 }

    /// The camera stage's aspect on screen: the photo slot turned by (preview − capture), so the
    /// stage frames exactly the crop that prints even when the photo is turned against the screen
    /// (a rotation-locked phone held sideways).
    public static func stageAspect(capture: Int, preview: Int) -> Double {
        let s = slotAspect(capture: capture)
        return isQuarter(preview - capture) ? 1 / s : s
    }

    /// Clockwise degrees that turn an upright (capture-angle) image to line up with the on-screen preview.
    public static func displayTurn(capture: Int, preview: Int) -> Int { normalize(Double(preview - capture)) }
}
