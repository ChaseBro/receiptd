// Live print preview: the camera stage shows the photo as the printer will dot
// it (index.html's #live canvas + preview.worker.js, natively). Each sensor
// frame is stood upright with the frame turn (the same turn grab() gives the
// photo), cover-cropped to the photo slot the strip will use (Frames.swift
// layout: 4:3 landscape / 4:5 portrait, at the width it prints for the current
// theme), scaled on the GPU (Core Image), then run through BoothCore's toneMap
// + ditherThermal + relieveSolids, like the print, on a background queue. One
// frame in flight: frames that arrive while busy are dropped. Below 5 fps for
// 3 s straight it turns itself off until settings are next closed. The dots are
// then turned by (preview − capture) so they line up with the plain video (0° unless
// a rotation-locked phone is held sideways).
//
// Shortcuts vs the print: no face metering (centre-weighted exposure), and the
// head heat starts cold at the top of the photo (the strip header and earlier
// photos aren't modelled).

import BoothCore
import CoreImage
import QuartzCore
import SwiftUI
import UIKit

final class LivePreview: @unchecked Sendable {
    private let queue = DispatchQueue(label: "booth.live", qos: .userInitiated)
    private let lock = NSLock()
    private let ci = CIContext(options: [.useSoftwareRenderer: false, .cacheIntermediates: false])
    private var busy = false
    private var active = false
    // fps window (under `lock`): counted from frames offered, so a stalled camera never reads as slow
    private var done = 0, t0 = 0.0, slow = 0
    private(set) var fps = 0.0
    private var ms = 0.0   // render cost per frame (EMA), for the accessibility value
    /// Main thread: the stage's dot layer (set by LiveDots while it's on screen).
    weak var view: UIView?
    /// Main thread: called once when the device can't keep up.
    var onSlow: (() -> Void)?

    /// LiveDots on/off screen: frames are only processed while the camera screen shows them.
    func setActive(_ on: Bool) { lock.lock(); active = on; t0 = 0; lock.unlock() }

    /// From the camera (any thread): a delivered frame (unmirrored), the clockwise turn that stands
    /// it upright (`Upright.frameTurn`) and the one that lines the upright dots up with the on-screen
    /// video (`Upright.displayTurn`). Dropped when busy or off screen.
    func offer(_ frame: @autoclosure () -> CIImage, turn: Int, display: Int) {
        lock.lock()
        guard active, !busy, Settings().livePreview else { lock.unlock(); return }
        let now = CACurrentMediaTime()
        var tooSlow = false
        if t0 == 0 { t0 = now; done = 0; slow = 0 }
        else if now - t0 >= 1 {
            fps = Double(done) / (now - t0)
            slow = fps < 5 ? slow + 1 : 0
            t0 = now; done = 0
            if slow >= 3 { active = false; tooSlow = true }
        }
        if tooSlow {
            lock.unlock()
            DispatchQueue.main.async { self.onSlow?() }
            return
        }
        busy = true
        lock.unlock()
        let img = frame()
        queue.async { [self] in
            let t = CACurrentMediaTime()
            let cg = render(BoothCamera.upright(img, turn)).map { rotate($0, display) }
            let dt = (CACurrentMediaTime() - t) * 1000
            lock.lock(); busy = false; if cg != nil { done += 1 }; ms = ms == 0 ? dt : 0.9 * ms + 0.1 * dt; let f = fps, m = ms; lock.unlock()
            guard let cg else { return }
            DispatchQueue.main.async { [weak self] in
                guard let v = self?.view else { return }
                CATransaction.begin(); CATransaction.setDisableActions(true)
                v.layer.contents = cg
                v.layer.backgroundColor = UIColor(Color.ink).cgColor   // letterbox around the slot, once there's a frame
                CATransaction.commit()
                v.accessibilityValue = String(format: "%.1f fps, %.1f ms", f, m)
            }
        }
    }

    private var rgba = [UInt8]()

    /// Background queue: frame → slot crop → print dither → tinted CGImage (one pixel per printed dot).
    private func render(_ img: CIImage) -> CGImage? {
        let s = Settings()
        let ext = img.extent
        guard ext.width >= 2, ext.height >= 2, ext.width.isFinite else { return nil }
        let fw = Double(ext.width), fh = Double(ext.height)
        let slot = layout(s.theme, frames: [(w: Int(fw), h: Int(fh))]).photos[0]
        let w = Int(slot.w), h = Int(slot.h)
        guard w > 0, h > 0 else { return nil }
        let crop = coverCrop(fw, fh, Double(w), Double(h))
        let k = Double(w) / crop.sw
        // Core Image is y-up; the centred crop is symmetric, so sy maps straight across.
        let cropped = img.cropped(to: CGRect(x: ext.minX + crop.sx, y: ext.minY + (fh - crop.sy - crop.sh), width: crop.sw, height: crop.sh))
        let scaled = cropped
            .transformed(by: CGAffineTransform(translationX: -cropped.extent.minX, y: -cropped.extent.minY))
            .transformed(by: CGAffineTransform(scaleX: k, y: k), highQualityDownsample: true)
        if rgba.count != w * h * 4 { rgba = [UInt8](repeating: 0, count: w * h * 4) }
        ci.render(scaled, toBitmap: &rgba, rowBytes: w * 4, bounds: CGRect(x: 0, y: 0, width: w, height: h),
                  format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB))
        var tone = ToneOptions(); tone.width = w; tone.height = h
        let gray = toneMap(luminance(rgba, w, h), tone)
        let opts = ThermalOptions(gain: s.gain, bleed: 0)
        var sink = 0.0
        let bits = relieveSolids(ditherThermal(gray[...], w, h, opts), w, h, ReliefOptions(), sink: &sink)
        return LivePreview.dotImage(bits, w, h)
    }

    /// 0/1 per pixel → CGImage through a two-entry palette (paper, ink: thermalImage's tint), no per-pixel loop.
    private static let palette: CGColorSpace? = {
        let table: [UInt8] = [255, 249, 255, 26, 20, 35]
        return CGColorSpace(name: CGColorSpace.sRGB).flatMap { CGColorSpace(indexedBaseSpace: $0, last: 1, colorTable: table) }
    }()
    static func dotImage(_ bits: [UInt8], _ w: Int, _ h: Int) -> CGImage? {
        guard let space = palette, let data = CGDataProvider(data: Data(bits) as CFData) else { return thermalImage(bits, h, w: w) }
        return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: w, space: space,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: data, decode: nil,
                       shouldInterpolate: false, intent: .defaultIntent)
    }
}

/// The dot layer over the camera stage: the slot's dithered frame, scaled to fit, nearest-neighbour.
struct LiveDots: UIViewRepresentable {
    @ObservedObject var camera: BoothCamera

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        v.layer.contentsGravity = .resizeAspect
        v.layer.magnificationFilter = .nearest
        v.layer.minificationFilter = .nearest
        v.isAccessibilityElement = true
        v.accessibilityIdentifier = "livePreview"
        v.accessibilityLabel = "Live print preview"
        camera.live.view = v
        camera.live.setActive(true)
        return v
    }

    func updateUIView(_ v: UIView, context: Context) {
        v.isHidden = !Settings().livePreview || camera.liveFallback
        v.isAccessibilityElement = !v.isHidden
        v.transform = camera.mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity   // selfie: mirrored, like the video
    }

    func makeCoordinator() -> LivePreview { camera.live }

    static func dismantleUIView(_ v: UIView, coordinator live: LivePreview) {
        // Off screen (review, printing, settings): stop dithering. Unless a newer LiveDots already took over.
        if live.view == nil || live.view === v { live.view = nil; live.setActive(false) }
    }
}
