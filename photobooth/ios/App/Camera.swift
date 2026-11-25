// The booth camera: AVCaptureSession with a live preview and a video-data
// output we grab frames from (like the web booth grabbing the <video>). Frames
// come out unmirrored (only the selfie preview is mirrored, like the Camera
// app). ↻ on the review screen fixes the odd one by hand.
//
// Which way is up (BoothCore Orientation.swift): sensor frames are landscape. One pair of
// clockwise angles, kept here, turns them:
//   - `captureAngle` (the rotation coordinator's horizon-level capture angle, from gravity) turns
//     every grabbed photo and every live-preview frame upright before the slot crop + dither, and
//     sets the photo slot's shape (4:5 when the upright frame is portrait);
//   - `previewAngle` (horizon-level preview, from the interface orientation of the preview layer)
//     turns the plain video on screen; the live dots are turned by (preview − capture) to match.
// The coordinator answers 0° for preview while its layer isn't in a window (AVCaptureDevice.h),
// and SwiftUI builds the preview layer before it is in one: so the coordinator is only made once
// the layer is on screen, and until then both angles come from `Upright.builtInAngle` for the
// current interface / device orientation. Before this, a coordinator made in makeUIView (every
// return to the camera screen) reported 0°: dots sideways, stage 4:3 on an upright phone.
//
// The Simulator has no camera: a fake sensor draws an up arrow, turns it the way a real sensor
// would see it (by −captureAngle, from the simulated device orientation) and feeds that landscape
// frame through the same rotation path.

import AVFoundation
import BoothCore
import CoreImage
import SwiftUI
import UIKit

final class BoothCamera: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    @Published var facing: AVCaptureDevice.Position = .front
    @Published var failed = false
    @Published private(set) var running = false
    /// Live print preview (LivePreview.swift): every frame, dithered like the print.
    let live = LivePreview()
    /// The device couldn't keep the live print preview above 5 fps: plain video until settings close.
    @Published var liveFallback = false
    /// Clockwise degrees that turn a sensor frame upright for capture (main thread).
    @Published private(set) var captureAngle = 90
    /// Clockwise degrees that turn a sensor frame for the on-screen preview (main thread).
    @Published private(set) var previewAngle = 90
    /// The upright photos are portrait: the photo slot is 4:5 instead of 4:3 (frames.js slotAspect).
    var portraitFrames: Bool { Upright.isQuarter(captureAngle) }
    /// The camera stage's aspect on screen (width / height): the photo slot, turned to the screen.
    var stageAspect: CGFloat { CGFloat(Upright.stageAspect(capture: captureAngle, preview: previewAngle)) }
    /// The on-screen selfie preview is mirrored, like the Camera app (settings → Mirror preview).
    /// Captures, prints and the archive never are.
    var mirrored: Bool { facing == .front && Settings().mirror }

    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "booth.camera")
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    /// The angles for the camera queue (under `lock`), mirrored from the @Published ones.
    private var angles = (capture: 90, preview: 90)
    private var coordinator: AVCaptureDevice.RotationCoordinator?
    private var input: AVCaptureDeviceInput?
    private let ci = CIContext(options: [.useSoftwareRenderer: false])
    /// The on-screen preview layer, set by CameraPreview once it is in a window (nil when off screen).
    weak var previewLayer: AVCaptureVideoPreviewLayer? { didSet { if previewLayer !== oldValue { configureCoordinator() } } }

    override init() {
        super.init()
        live.onSlow = { [weak self] in self?.liveFallback = true }
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NotificationCenter.default.addObserver(self, selector: #selector(orientationChanged), name: UIDevice.orientationDidChangeNotification, object: nil)
    }

    @objc private func orientationChanged() { DispatchQueue.main.async { self.updateAngles() } }

    /// Main thread: set both angles (and the preview layer's), then hand them to the camera queue.
    private func setAngles(capture: Int, preview: Int) {
        if captureAngle != capture { captureAngle = capture }
        if previewAngle != preview { previewAngle = preview }
        lock.lock(); angles = (capture, preview); lock.unlock()
        if let c = previewLayer?.connection, c.isVideoRotationAngleSupported(CGFloat(preview)), c.videoRotationAngle != CGFloat(preview) {
            c.videoRotationAngle = CGFloat(preview)
        }
    }

    /// The interface orientation of the booth's window (the preview's), as a BoothCore `Hold`.
    static func interfaceHold() -> Hold {
        let o = MainActor.assumeIsolated { () -> UIInterfaceOrientation in
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
            return scene?.effectiveGeometry.interfaceOrientation ?? .portrait
        }
        switch o {
        case .portraitUpsideDown: return .portraitUpsideDown
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        default: return .portrait
        }
    }

    /// Which way gravity holds the device; face up / down / unknown fall back to the interface.
    static func deviceHold() -> Hold {
        switch MainActor.assumeIsolated({ UIDevice.current.orientation }) {
        case .portrait: return .portrait
        case .portraitUpsideDown: return .portraitUpsideDown
        case .landscapeLeft: return .landscapeRight    // UIDevice's landscapeLeft = Home button on the right
        case .landscapeRight: return .landscapeLeft
        default: return interfaceHold()
        }
    }

    /// Main thread: the layer belongs to a view that is in a window.
    static func inWindow(_ layer: CALayer?) -> Bool {
        guard let v = layer?.delegate as? UIView else { return false }
        return MainActor.assumeIsolated { v.window != nil }
    }

    /// The fallback angles (no coordinator yet, or no camera): what a built-in camera reports.
    private func fallbackAngles() -> (capture: Int, preview: Int) {
        let front = facing == .front
        return (Upright.builtInAngle(BoothCamera.deviceHold(), front: front), Upright.builtInAngle(BoothCamera.interfaceHold(), front: front))
    }

    #if targetEnvironment(simulator)
    // No camera in the Simulator: a fake sensor (an up arrow, turned as a real sensor sees it)
    // stands in, so the whole booth flow (capture → review → print → archive) and the rotation
    // path can be exercised.
    @Published var fake: CGImage?
    private var fakeTimer: Timer?
    func start() {
        running = true; failed = false
        updateAngles()
        fakeTimer?.invalidate()
        fakeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15, repeats: true) { [weak self] _ in
            guard let self else { return }
            updateAngles()   // the Simulator turns without a coordinator: follow it every frame
            let t = Date().timeIntervalSince1970
            lock.lock(); let a = angles; lock.unlock()
            let sensor = BoothCamera.fakeSensor(t, angle: a.capture)
            // The plain preview: the sensor frame turned by the preview angle, as the preview layer does.
            fake = CIImage(cgImage: sensor).oriented(Upright.orientation(a.preview)).cgImage(ci)
            live.offer(CIImage(cgImage: sensor), capture: a.capture, preview: a.preview)
        }
    }
    func stop() { fakeTimer?.invalidate(); running = false }
    func flip() { facing = facing == .front ? .back : .front; updateAngles() }
    private func configureCoordinator() { updateAngles() }
    private func updateAngles() { let a = fallbackAngles(); setAngles(capture: a.capture, preview: a.preview) }
    private func sensorFrame() -> (CIImage, Int)? {
        lock.lock(); let a = angles.capture; lock.unlock()
        return (CIImage(cgImage: BoothCamera.fakeSensor(Date().timeIntervalSince1970, angle: a, w: 1440, h: 1080)), a)
    }

    /// What a landscape sensor sees of the fake scene: the upright scene (`scene`) turned
    /// counter-clockwise by `angle`, so turning it clockwise by `angle` stands it up again.
    static func fakeSensor(_ t: Double, angle: Int, w: Int = 480, h: Int = 360) -> CGImage {
        let q = Upright.isQuarter(angle)
        let up = scene(t, w: q ? h : w, h: q ? w : h)
        return rotate(up, -angle)
    }

    /// The fake scene, upright and unmirrored: light paper, a big ink arrow pointing up (head wider
    /// than the shaft, so "up" is the darker top half), a mint block at the right edge (shows
    /// mirroring), and a small dot circling the centre so the frames move. No text.
    static func scene(_ t: Double, w: Int, h: Int) -> CGImage {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        let W = CGFloat(w), H = CGFloat(h)
        // CG is y-up: flip so the drawing below reads y-down (top = 0).
        ctx.translateBy(x: 0, y: H); ctx.scaleBy(x: 1, y: -1)
        ctx.setFillColor(CGColor(red: 0.93, green: 0.92, blue: 0.88, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
        let ink = CGColor(red: 0.08, green: 0.07, blue: 0.1, alpha: 1)
        ctx.setFillColor(ink)
        let m = min(W, H)
        ctx.beginPath()
        ctx.move(to: CGPoint(x: W / 2, y: H * 0.5 - m * 0.40))
        ctx.addLine(to: CGPoint(x: W / 2 + m * 0.30, y: H * 0.5 - m * 0.02))
        ctx.addLine(to: CGPoint(x: W / 2 - m * 0.30, y: H * 0.5 - m * 0.02))
        ctx.closePath(); ctx.fillPath()
        ctx.fill(CGRect(x: W / 2 - m * 0.08, y: H * 0.5 - m * 0.03, width: m * 0.16, height: m * 0.36))
        // Mirroring marker: at mid height, so it weighs nothing for up / down.
        ctx.setFillColor(ink)
        ctx.fill(CGRect(x: W * 0.86, y: H * 0.42, width: W * 0.09, height: H * 0.16))
        // Motion: a small dot circling.
        let r = m * 0.42, a = t * 2
        ctx.fillEllipse(in: CGRect(x: W / 2 + r * CGFloat(cos(a)) - m * 0.02, y: H / 2 + r * CGFloat(sin(a)) - m * 0.02, width: m * 0.04, height: m * 0.04))
        return ctx.makeImage()!
    }
    #else
    func start() {
        queue.async { [self] in
            if session.inputs.isEmpty || input?.device.position != facing { configure() }
            if !session.isRunning { session.startRunning() }
            DispatchQueue.main.async { self.running = self.session.isRunning }
        }
    }

    func stop() { queue.async { [self] in session.stopRunning(); DispatchQueue.main.async { self.running = false } } }

    func flip() {
        facing = facing == .front ? .back : .front
        queue.async { [self] in configure() }
    }

    /// 4:3, about 1920 px wide (the web booth asks for 1920×1440).
    private func bestFormat(_ d: AVCaptureDevice) -> AVCaptureDevice.Format? {
        d.formats.filter {
            let dims = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
            return abs(Double(dims.width) / Double(dims.height) - 4.0 / 3) < 0.01 && dims.width <= 2112 && dims.width >= 1280
                && CMFormatDescriptionGetMediaSubType($0.formatDescription) == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        }.max { CMVideoFormatDescriptionGetDimensions($0.formatDescription).width < CMVideoFormatDescriptionGetDimensions($1.formatDescription).width }
    }

    private func configure() {
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if let i = input { session.removeInput(i) }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: facing),
              let inp = try? AVCaptureDeviceInput(device: device), session.canAddInput(inp) else {
            DispatchQueue.main.async { self.failed = true }; return
        }
        session.sessionPreset = .inputPriority
        session.addInput(inp); input = inp
        if let f = bestFormat(device), (try? device.lockForConfiguration()) != nil { device.activeFormat = f; device.unlockForConfiguration() }
        else { session.sessionPreset = .high }
        if session.outputs.isEmpty {
            output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            output.alwaysDiscardsLateVideoFrames = true
            output.setSampleBufferDelegate(self, queue: queue)
            if session.canAddOutput(output) { session.addOutput(output) }
        }
        // Frames stay in sensor orientation (rotated here, in Core Image) and unmirrored.
        output.connection(with: .video)?.isVideoMirrored = false
        DispatchQueue.main.async { self.failed = false; self.configureCoordinator() }
    }

    private var observations: [NSKeyValueObservation] = []
    /// Main thread. A coordinator for the current camera, with the preview layer only while that layer
    /// is in a window (otherwise its preview angle reads 0°): until then, the preview angle is the
    /// built-in one for the interface orientation. Re-made when the camera flips or the layer changes.
    private func configureCoordinator() {
        guard let device = input?.device else { updateAngles(); return }
        let layer = BoothCamera.inWindow(previewLayer) ? previewLayer : nil
        let c = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: layer)
        coordinator = c
        observations = [
            c.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.updateAngles() } },
            c.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.updateAngles() } },
        ]
        updateAngles()
    }

    /// Main thread: read the angles from the coordinator (or the built-in fallback).
    private func updateAngles() {
        let fb = fallbackAngles()
        guard let c = coordinator, c.device === input?.device else { setAngles(capture: fb.capture, preview: fb.preview); return }
        let capture = Upright.normalize(c.videoRotationAngleForHorizonLevelCapture)
        // Trust the preview angle only while the coordinator's layer is the live, on-screen one.
        let onScreen = c.previewLayer != nil && c.previewLayer === previewLayer && BoothCamera.inWindow(previewLayer)
        let preview = onScreen ? Upright.normalize(c.videoRotationAngleForHorizonLevelPreview) : fb.preview
        setAngles(capture: capture, preview: preview)
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        lock.lock(); latest = pb; let a = angles; lock.unlock()
        // The sensor frame; LivePreview stands it up (capture angle), crops + dithers, then turns the
        // dots to match the on-screen video. Not mirrored here: LiveDots mirrors the selfie view.
        live.offer(CIImage(cvPixelBuffer: pb), capture: a.capture, preview: a.preview)
    }

    private func sensorFrame() -> (CIImage, Int)? {
        lock.lock(); let pb = latest; let a = angles.capture; lock.unlock()
        return pb.map { (CIImage(cvPixelBuffer: $0), a) }
    }
    #endif

    /// The current frame, upright (capture angle), unmirrored: `full` at native size (archive) and
    /// `frame` capped at 1440 px (compose), like index.html grab(). Same path on device and Simulator.
    func grab() -> (frame: CGImage, full: CGImage)? {
        guard let f = sensorFrame() else { return nil }
        let img = BoothCamera.upright(f.0, f.1)
        guard let full = ci.createCGImage(img, from: img.extent, format: .BGRA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else { return nil }
        let scale = min(1, 1440 / max(img.extent.width, img.extent.height))
        if scale >= 1 { return (full, full) }
        let small = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let r = CGRect(x: 0, y: 0, width: (img.extent.width * scale).rounded(), height: (img.extent.height * scale).rounded())
        guard let frame = ci.createCGImage(small, from: r.offsetBy(dx: small.extent.minX, dy: small.extent.minY), format: .BGRA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else { return nil }
        return (frame, full)
    }

    /// A sensor frame turned upright by `angle` clockwise degrees, its extent at the origin.
    static func upright(_ sensor: CIImage, _ angle: Int) -> CIImage {
        let o = sensor.oriented(Upright.orientation(angle))
        return o.transformed(by: CGAffineTransform(translationX: -o.extent.minX, y: -o.extent.minY))
    }
}

extension CIImage {
    func cgImage(_ ctx: CIContext) -> CGImage? { ctx.createCGImage(self, from: extent) }
}

/// Live preview (mirrored for the selfie camera, like the Camera app).
struct CameraPreview: UIViewRepresentable {
    @ObservedObject var camera: BoothCamera

    /// Hands its layer to the camera only once it is in a window (the rotation coordinator's
    /// preview angle is 0° for a layer that isn't), and takes it back when it leaves.
    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
        weak var camera: BoothCamera?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let camera else { return }
            if window != nil { camera.previewLayer = preview }
            else if camera.previewLayer === preview { camera.previewLayer = nil }
        }
    }

    #if targetEnvironment(simulator)
    /// Sized by the stage, never by the image (a UIImageView's intrinsic size is its image's).
    final class FillImageView: UIImageView { override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: UIView.noIntrinsicMetric) } }
    func makeUIView(context: Context) -> FillImageView {
        let v = FillImageView(); v.contentMode = .scaleAspectFill; v.clipsToBounds = true
        v.isAccessibilityElement = true; v.accessibilityIdentifier = "cameraPreview"; v.accessibilityLabel = "Camera"
        return v
    }
    func updateUIView(_ v: FillImageView, context: Context) { v.image = camera.fake.map { UIImage(cgImage: $0) }; v.accessibilityValue = "capture \(camera.captureAngle), preview \(camera.previewAngle)"; v.transform = camera.mirrored ? CGAffineTransform(scaleX: -1, y: 1) : .identity }
    #else
    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.preview.session = camera.session
        v.preview.videoGravity = .resizeAspectFill
        v.isAccessibilityElement = true; v.accessibilityIdentifier = "cameraPreview"; v.accessibilityLabel = "Camera"
        v.camera = camera   // the layer reaches the camera in didMoveToWindow, not here
        return v
    }

    func updateUIView(_ v: PreviewView, context: Context) {
        v.accessibilityValue = "capture \(camera.captureAngle), preview \(camera.previewAngle)"
        if let c = v.preview.connection, c.isVideoMirroringSupported {
            c.automaticallyAdjustsVideoMirroring = false
            c.isVideoMirrored = camera.mirrored
        }
        if let c = v.preview.connection, c.isVideoRotationAngleSupported(CGFloat(camera.previewAngle)) { c.videoRotationAngle = CGFloat(camera.previewAngle) }
    }
    #endif
}

/// Rotate an upright frame by a ↻ fix (clockwise degrees).
func rotate(_ img: CGImage, _ deg: Int) -> CGImage {
    let d = ((deg % 360) + 360) % 360
    if d == 0 { return img }
    let swap = d % 180 != 0
    let w = swap ? img.height : img.width, h = swap ? img.width : img.height
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return img }
    ctx.interpolationQuality = .none   // quarter turns map pixels exactly: no resampling (keeps live dots crisp)
    ctx.translateBy(x: CGFloat(w) / 2, y: CGFloat(h) / 2)
    ctx.rotate(by: -CGFloat(d) * .pi / 180)    // CG is y-up: negative = clockwise on screen
    ctx.draw(img, in: CGRect(x: -CGFloat(img.width) / 2, y: -CGFloat(img.height) / 2, width: CGFloat(img.width), height: CGFloat(img.height)))
    return ctx.makeImage() ?? img
}
