// Camera orientation: the one place that says which way is up.
//
// Built-in cameras deliver frames in the sensor's native orientation (landscape on every camera so
// far, but AVCaptureDevice.h warns "some cameras are upright when the device is held with the port
// on the bottom, while others are upright when holding the device with the port on the left or
// right"). AVFoundation's rotation coordinator reports two clockwise angles relative to that native
// orientation: one for *capture* (photos: from gravity) and one for *preview* (the on-screen view:
// from the interface orientation of the layer showing it). The booth applies
//   - (capture − the data output's own rotation) to every grabbed frame and live-preview frame
//     before the slot crop + dither (`frameTurn`: AVCaptureSession.h says the video data output's
//     default `videoRotationAngle` is 180° on the front camera of the Spring 2024 iPads and asks
//     apps that rotate frames themselves to account for it on every device), and
//   - the difference (preview − capture) to show those dots lined up with the plain video,
// and takes the photo slot's shape (4:3 / 4:5) from the upright frame's real size (frames.js
// slotAspect, Frames.swift), turned to screen space for the camera stage (`stageAspect`).
//
// `builtInAngle` is what a classic built-in iPhone / iPad camera reports for a given orientation
// (back sensor native with the port on the right, front with it on the left). The app uses it only
// before the coordinator is ready. `SensorMount` models the hardware from geometry (which device
// edge the sensor's top row faces, and which way the camera looks), independently of that table:
// the tests check the table against it, and the Simulator's fake camera is built on it.
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

    /// Clockwise degrees that stand a *delivered* frame upright: the capture angle (relative to the
    /// native sensor orientation) minus the rotation the video data output's connection already
    /// applied to the buffer (its `videoRotationAngle`; 0 once the booth resets it, 180° by default
    /// on some front cameras).
    public static func frameTurn(capture: Int, buffer: Int) -> Int { normalize(Double(capture - buffer)) }

    /// The upright frame's size: a delivered `w`×`h` buffer turned by `turn` clockwise degrees.
    public static func uprightSize(_ w: Int, _ h: Int, turn: Int) -> (w: Int, h: Int) { isQuarter(turn) ? (h, w) : (w, h) }

    /// The upright frame is portrait (taller than wide). With no buffer yet, assume a landscape
    /// (classic) sensor buffer.
    public static func uprightIsPortrait(buffer: (w: Int, h: Int)?, turn: Int) -> Bool {
        guard let b = buffer, b.w > 0, b.h > 0 else { return isQuarter(turn) }
        let u = uprightSize(b.w, b.h, turn: turn)
        return u.h > u.w
    }

    /// The photo slot's aspect (width / height): 4:5 for portrait upright frames, else 4:3
    /// (frames.js slotAspect: `w >= h ? 4/3 : 4/5`).
    public static func slotAspect(portrait: Bool) -> Double { portrait ? 4.0 / 5 : 4.0 / 3 }

    /// The camera stage's aspect on screen: the photo slot turned by (preview − capture), so the
    /// stage frames exactly the crop that prints even when the photo is turned against the screen
    /// (a rotation-locked phone held sideways).
    public static func stageAspect(portrait: Bool, capture: Int, preview: Int) -> Double {
        let s = slotAspect(portrait: portrait)
        return isQuarter(preview - capture) ? 1 / s : s
    }

    /// Clockwise degrees that turn an upright (capture-angle) image to line up with the on-screen preview.
    public static func displayTurn(capture: Int, preview: Int) -> Int { normalize(Double(preview - capture)) }
}

/// A device edge, seen looking at the screen with the device upright (port at the bottom).
public enum Edge: String, Sendable { case top, bottom, left, right }

/// A physical model of a built-in camera, from geometry alone (no angle tables): which device edge
/// the native buffer's top row points at, and whether the camera looks out of the screen (front)
/// or out of the back. The buffer's right-hand direction follows from those two (image right ×
/// image down = the way the camera looks).
///
/// Real hardware (the classic layout): the back sensor's buffer is upright with the port on the
/// right (its top row faces the device's right edge), the front sensor's with the port on the left
/// (top row faces the left edge). That is why a back-camera portrait photo needs a quarter turn
/// clockwise, the legacy portrait selfie orientation is `.leftMirrored`, and AVCaptureDevice.h says
/// "when an iOS device is held in portrait orientation ... built-in cameras may need to be rotated
/// by 90 degrees". `frontPortraitNative` models a camera upright with the port on the bottom (the
/// header's "some cameras are upright when the device is held with the port on the bottom").
public struct SensorMount: Sendable, Equatable {
    public let up: Edge
    public let front: Bool
    public init(up: Edge, front: Bool) { self.up = up; self.front = front }

    public static let back = SensorMount(up: .right, front: false)
    public static let front = SensorMount(up: .left, front: true)
    public static let frontPortraitNative = SensorMount(up: .top, front: true)

    /// The native buffer is landscape (its top row runs along a long edge of the device).
    public var landscapeBuffer: Bool { up == .left || up == .right }

    private typealias V = (x: Int, y: Int, z: Int)
    private static func vec(_ e: Edge) -> V {
        switch e { case .top: return (0, 1, 0); case .bottom: return (0, -1, 0); case .left: return (-1, 0, 0); case .right: return (1, 0, 0) }
    }
    private static func cross(_ a: V, _ b: V) -> V { (a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x) }
    private static func dot(_ a: V, _ b: V) -> Int { a.x * b.x + a.y * b.y + a.z * b.z }

    /// Clockwise degrees that stand this camera's native buffer upright with the device held `hold`
    /// (for capture: `hold` from gravity; for preview: the interface orientation).
    public func horizonAngle(_ hold: Hold) -> Int {
        // Device frame: x → right edge, y → top edge, z → out of the screen.
        let look: V = front ? (0, 0, 1) : (0, 0, -1)
        let u = SensorMount.vec(up), down: V = (-u.x, -u.y, -u.z)
        let right = SensorMount.cross(down, look)   // right × down = look  ⇒  right = down × look
        // World up, in the device frame (landscapeRight = port on the right: the right edge is up).
        let world: V
        switch hold {
        case .portrait: world = (0, 1, 0)
        case .portraitUpsideDown: world = (0, -1, 0)
        case .landscapeRight: world = (1, 0, 0)
        case .landscapeLeft: world = (-1, 0, 0)
        }
        // Where the scene's "up" lies in the buffer; a clockwise turn moves top → right → bottom → left.
        if SensorMount.dot(world, u) == 1 { return 0 }          // already at the top
        if SensorMount.dot(world, right) == -1 { return 90 }    // at the left: a quarter turn clockwise
        if SensorMount.dot(world, u) == -1 { return 180 }       // at the bottom
        return 270                                              // at the right
    }
}
