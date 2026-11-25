// The booth camera: AVCaptureSession with a live preview and a video-data
// output we grab frames from (like the web booth grabbing the <video>). Frames
// come out unmirrored (only the selfie preview is mirrored, like the Camera
// app) and are turned upright with the rotation coordinator's horizon-level
// capture angle, so a turned iPad or a locked-rotation phone still gives
// upright photos. ↻ on the review screen fixes the odd one by hand.

import AVFoundation
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
    /// The on-screen frames are portrait (the preview turned a quarter): the photo slot, and so the
    /// camera stage, is 4:5 instead of 4:3 (frames.js slotAspect). Flips as the device turns.
    @Published var portraitFrames = false
    /// The photo slot's aspect (width / height) for the current frame shape.
    var slotAspect: CGFloat { portraitFrames ? 4.0 / 5 : 4.0 / 3 }

    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "booth.camera")
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    private var coordinator: AVCaptureDevice.RotationCoordinator?
    private var input: AVCaptureDeviceInput?
    private let ci = CIContext(options: [.useSoftwareRenderer: false])
    weak var previewLayer: AVCaptureVideoPreviewLayer? { didSet { configureCoordinator() } }
    /// The preview layer's rotation (under `lock`): the live print preview turns frames the same way.
    private var previewAngle: CGFloat = 90

    override init() {
        super.init()
        live.onSlow = { [weak self] in self?.liveFallback = true }
    }

    #if targetEnvironment(simulator)
    // No camera in the Simulator: a moving test pattern stands in, so the whole
    // booth flow (capture → review → print → archive) can be exercised.
    @Published var fake: CGImage?
    private var fakeTimer: Timer?
    func start() {
        running = true; failed = false
        fakeTimer?.invalidate()
        fakeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15, repeats: true) { [weak self] _ in
            let f = BoothCamera.pattern(Date().timeIntervalSince1970)
            self?.fake = f
            self?.live.offer(CIImage(cgImage: f))
        }
    }
    func stop() { fakeTimer?.invalidate(); running = false }
    func flip() { facing = facing == .front ? .back : .front }
    func grab() -> (frame: CGImage, full: CGImage)? { let f = BoothCamera.pattern(Date().timeIntervalSince1970, w: 1440, h: 1080); return (f, f) }
    static func pattern(_ t: Double, w: Int = 480, h: Int = 360) -> CGImage {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        let W = CGFloat(w), H = CGFloat(h)
        let g = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!, colors: [CGColor(red: 0.95, green: 0.85, blue: 0.7, alpha: 1), CGColor(red: 0.15, green: 0.25, blue: 0.4, alpha: 1)] as CFArray, locations: [0, 1])!
        ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: W, y: H), options: [])
        let cx = W / 2 + W * 0.25 * CGFloat(sin(t)), cy = H * 0.55
        ctx.setFillColor(CGColor(red: 0.93, green: 0.76, blue: 0.62, alpha: 1)); ctx.fillEllipse(in: CGRect(x: cx - H * 0.2, y: cy - H * 0.25, width: H * 0.4, height: H * 0.5))
        ctx.setFillColor(CGColor(gray: 0.1, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: cx - H * 0.1, y: cy + H * 0.05, width: H * 0.06, height: H * 0.06)); ctx.fillEllipse(in: CGRect(x: cx + H * 0.04, y: cy + H * 0.05, width: H * 0.06, height: H * 0.06))
        ctx.fill(CGRect(x: 0, y: 0, width: W, height: H * 0.12))
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
    #endif

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
        output.connection(with: .video)?.isVideoMirrored = false
        DispatchQueue.main.async { self.failed = false; self.configureCoordinator() }
    }

    private var observation: NSKeyValueObservation?
    private func configureCoordinator() {
        guard let device = input?.device else { return }
        coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
        if let c = previewLayer?.connection, let a = coordinator?.videoRotationAngleForHorizonLevelPreview, c.isVideoRotationAngleSupported(a) { c.videoRotationAngle = a }
        if let a = coordinator?.videoRotationAngleForHorizonLevelPreview { lock.lock(); previewAngle = a; lock.unlock(); portraitFrames = BoothCamera.isQuarter(a) }
        observation = coordinator?.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] co, _ in
            let a = co.videoRotationAngleForHorizonLevelPreview
            if let self { lock.lock(); previewAngle = a; lock.unlock() }
            DispatchQueue.main.async {
                if let c = self?.previewLayer?.connection, c.isVideoRotationAngleSupported(a) { c.videoRotationAngle = a }
                if self?.portraitFrames != BoothCamera.isQuarter(a) { self?.portraitFrames = BoothCamera.isQuarter(a) }
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        lock.lock(); latest = pb; let angle = Int(previewAngle); lock.unlock()
        // Turned like the on-screen preview (not mirrored: LiveDots mirrors the selfie view, as the preview layer does).
        live.offer(CIImage(cvPixelBuffer: pb).oriented(BoothCamera.orientation(angle)))
    }

    /// A quarter turn (90° / 270°) of the landscape sensor gives portrait frames.
    static func isQuarter(_ angle: CGFloat) -> Bool { (Int(angle.rounded()) % 180 + 180) % 180 == 90 }

    /// Clockwise degrees → the CG orientation that turns a sensor frame by them.
    static func orientation(_ angle: Int) -> CGImagePropertyOrientation {
        [0: .up, 90: .right, 180: .down, 270: .left][((angle % 360) + 360) % 360] ?? .up
    }

    #if !targetEnvironment(simulator)
    /// The current frame, upright, unmirrored: `full` at native size (archive) and
    /// `frame` capped at 1440 px (compose), like index.html grab().
    func grab() -> (frame: CGImage, full: CGImage)? {
        lock.lock(); let pb = latest; lock.unlock()
        guard let pb else { return nil }
        // Clockwise degrees that make the sensor image level with the horizon.
        let angle = Int(coordinator?.videoRotationAngleForHorizonLevelCapture ?? 90)
        var img = CIImage(cvPixelBuffer: pb)
        img = img.oriented(BoothCamera.orientation(angle))
        guard let full = ci.createCGImage(img, from: img.extent, format: .BGRA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else { return nil }
        let scale = min(1, 1440 / max(img.extent.width, img.extent.height))
        if scale >= 1 { return (full, full) }
        let small = img.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let r = CGRect(x: 0, y: 0, width: (img.extent.width * scale).rounded(), height: (img.extent.height * scale).rounded())
        guard let frame = ci.createCGImage(small, from: r.offsetBy(dx: small.extent.minX, dy: small.extent.minY), format: .BGRA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else { return nil }
        return (frame, full)
    }
    #endif
}

/// Live preview (mirrored for the selfie camera, like the Camera app).
struct CameraPreview: UIViewRepresentable {
    @ObservedObject var camera: BoothCamera

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    #if targetEnvironment(simulator)
    func makeUIView(context: Context) -> UIImageView { let v = UIImageView(); v.contentMode = .scaleAspectFill; v.clipsToBounds = true; return v }
    func updateUIView(_ v: UIImageView, context: Context) { v.image = camera.fake.map { UIImage(cgImage: $0) }; v.transform = camera.facing == .front ? CGAffineTransform(scaleX: -1, y: 1) : .identity }
    #else
    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.preview.session = camera.session
        v.preview.videoGravity = .resizeAspectFill
        camera.previewLayer = v.preview
        return v
    }

    func updateUIView(_ v: PreviewView, context: Context) {
        if let c = v.preview.connection, c.isVideoMirroringSupported {
            c.automaticallyAdjustsVideoMirroring = false
            c.isVideoMirrored = camera.facing == .front
        }
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
    ctx.translateBy(x: CGFloat(w) / 2, y: CGFloat(h) / 2)
    ctx.rotate(by: -CGFloat(d) * .pi / 180)    // CG is y-up: negative = clockwise on screen
    ctx.draw(img, in: CGRect(x: -CGFloat(img.width) / 2, y: -CGFloat(img.height) / 2, width: CGFloat(img.width), height: CGFloat(img.height)))
    return ctx.makeImage() ?? img
}
