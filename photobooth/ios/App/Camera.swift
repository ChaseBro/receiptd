// The booth camera: AVCaptureSession with a live preview and a video-data
// output we grab frames from (like the web booth grabbing the <video>). Frames
// come out unmirrored (only the selfie preview is mirrored, like the Camera
// app). ↻ on the review screen fixes the odd one by hand.
//
// Which way is up (BoothCore Orientation.swift): frames arrive in the sensor's native orientation.
// The angles, kept here:
//   - `captureAngle` (the rotation coordinator's horizon-level capture angle, from gravity, relative
//     to the native sensor orientation);
//   - `bufferAngle`, the rotation the video data output's connection already applies to the
//     buffers it delivers. The booth sets it to 0, but AVCaptureSession.h warns its default is 180°
//     on some front cameras (Spring 2024 iPads) and asks apps that rotate frames themselves to
//     account for it on every device, so it is read back and subtracted: every grabbed photo and
//     every live-preview frame is turned upright by `frameTurn` = capture − buffer before the slot
//     crop + dither. The photo slot's shape (4:5 / 4:3) comes from the upright frame's real size
//     (like Frames.swift's layout), not from the angle;
//   - `previewAngle` (horizon-level preview, from the interface orientation of the preview layer)
//     turns the plain video on screen; the live dots are turned by (preview − capture) to match.
// The coordinator answers 0° for preview while its layer isn't in a window (AVCaptureDevice.h),
// and SwiftUI builds the preview layer before it is in one: so the coordinator only gets the layer
// once it is on screen, and until then the preview angle (and, with no coordinator, the capture
// angle) is the camera's static angle for the current orientation (iOS 27's
// videoRotationAngleRelative(toDeviceOrientation:), else `Upright.builtInAngle`).
//
// Settings → About this booth shows all of it (and os_log, subsystem com.chasebro.booth, logs it
// once per camera start), so a real device can be read off without Xcode.
//
// The Simulator has no camera: a fake sensor built from a physical model of the hardware
// (BoothCore `SensorMount`, not the app's angle table) sees an up arrow the way a real sensor would,
// a fake coordinator reports that model's angles, and the frames go through the same rotation path.
// `-booth.fakeCamera connection180` (the front connection pre-rotates buffers 180° and keeps it)
// and `portraitNative` (a front camera upright with the port at the bottom) stress the other cases.

import AVFoundation
import BoothCore
import CoreImage
import os
import SwiftUI
import UIKit

let cameraLog = Logger(subsystem: "com.chasebro.booth", category: "camera")

final class BoothCamera: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    @Published var facing: AVCaptureDevice.Position = .front
    @Published var failed = false
    @Published private(set) var running = false
    /// Live print preview (LivePreview.swift): every frame, dithered like the print.
    let live = LivePreview()
    /// The device couldn't keep the live print preview above 5 fps: plain video until settings close.
    @Published var liveFallback = false
    /// Clockwise degrees that turn a native sensor frame upright for capture (main thread).
    @Published private(set) var captureAngle = 90
    /// Clockwise degrees that turn a native sensor frame for the on-screen preview (main thread).
    @Published private(set) var previewAngle = 90
    /// Clockwise degrees the data output's connection already turned the buffers it delivers (main thread).
    @Published private(set) var bufferAngle = 0
    /// The size of the buffers the data output delivers (main thread; nil before the first frame).
    @Published private(set) var bufferSize: (w: Int, h: Int)?
    /// The coordinator in use: none / without a layer / with the on-screen preview layer.
    @Published private(set) var coordinatorState = "no"
    /// Diagnostics as they were the last time the camera screen was showing (settings replaces it).
    private(set) var lastOnScreen: [(String, String)] = []
    /// Main thread: keep what the camera screen sees now (Booth calls it as settings open).
    func rememberOnScreen() { lastOnScreen = diagnostics() }

    /// Clockwise degrees that turn a delivered buffer upright.
    var frameTurn: Int { Upright.frameTurn(capture: captureAngle, buffer: bufferAngle) }
    /// The upright photos are portrait: the photo slot is 4:5 instead of 4:3 (frames.js slotAspect).
    var portraitFrames: Bool { Upright.uprightIsPortrait(buffer: bufferSize, turn: frameTurn) }
    /// The camera stage's aspect on screen (width / height): the photo slot, turned to the screen.
    var stageAspect: CGFloat { CGFloat(Upright.stageAspect(portrait: portraitFrames, capture: captureAngle, preview: previewAngle)) }
    /// The on-screen selfie preview is mirrored, like the Camera app (settings → Mirror preview).
    /// Captures, prints and the archive never are.
    var mirrored: Bool { facing == .front && Settings().mirror }

    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "booth.camera")
    private let lock = NSLock()
    private var latest: CVPixelBuffer?
    /// For the camera queue (under `lock`), mirrored from the @Published ones.
    private var angles = (capture: 90, preview: 90, buffer: 0)
    /// Under `lock`: the last buffer size seen, and whether this camera start still owes a log line.
    private var seenSize: (w: Int, h: Int)?
    private var logPending = false
    private var coordinator: AVCaptureDevice.RotationCoordinator?
    private var input: AVCaptureDeviceInput?
    private let ci = CIContext(options: [.useSoftwareRenderer: false])
    /// The on-screen preview layer, set by CameraPreview once it is in a window (nil when off screen).
    weak var previewLayer: AVCaptureVideoPreviewLayer? {
        didSet {
            guard previewLayer !== oldValue else { return }
            configureCoordinator()
        }
    }

    override init() {
        super.init()
        live.onSlow = { [weak self] in self?.liveFallback = true }
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        NotificationCenter.default.addObserver(self, selector: #selector(orientationChanged), name: UIDevice.orientationDidChangeNotification, object: nil)
    }

    @objc private func orientationChanged() { DispatchQueue.main.async { self.updateAngles() } }

    /// Main thread: set the angles (and the preview layer's), then hand them to the camera queue.
    private func setAngles(capture: Int, preview: Int, buffer: Int) {
        if captureAngle != capture { captureAngle = capture }
        if previewAngle != preview { previewAngle = preview }
        if bufferAngle != buffer { bufferAngle = buffer }
        lock.lock(); angles = (capture, preview, buffer); lock.unlock()
        if let c = previewLayer?.connection, c.isVideoRotationAngleSupported(CGFloat(preview)), c.videoRotationAngle != CGFloat(preview) {
            c.videoRotationAngle = CGFloat(preview)
        }
    }

    /// Any thread, per frame: note the buffer size (published when it changes) and log once per start.
    private func sawFrame(_ w: Int, _ h: Int) {
        lock.lock()
        let changed = seenSize.map { $0.w != w || $0.h != h } ?? true
        if changed { seenSize = (w, h) }
        let log = logPending; logPending = false
        lock.unlock()
        guard changed || log else { return }
        DispatchQueue.main.async { [self] in
            if changed { bufferSize = (w, h) }
            if log { logDiagnostics() }
        }
    }

    private func markStart() { lock.lock(); logPending = true; lock.unlock() }

    /// The interface orientation of the booth's window (the preview's), as a BoothCore `Hold`.
    static func interfaceHold() -> Hold {
        switch interfaceOrientation() {
        case .portraitUpsideDown: return .portraitUpsideDown
        case .landscapeLeft: return .landscapeLeft
        case .landscapeRight: return .landscapeRight
        default: return .portrait
        }
    }

    static func interfaceOrientation() -> UIInterfaceOrientation {
        MainActor.assumeIsolated { () -> UIInterfaceOrientation in
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
            return scene?.effectiveGeometry.interfaceOrientation ?? .portrait
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

    // MARK: diagnostics (Settings → About this booth; os_log once per camera start)

    /// Main thread: what the camera is doing, as label / value pairs, plain text.
    func diagnostics() -> [(String, String)] {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = "\(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))"
        var model = utsname(); uname(&model)
        let machine = withUnsafeBytes(of: &model.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
        let turn = frameTurn
        let upright = bufferSize.map { Upright.uprightSize($0.w, $0.h, turn: turn) }
        var rows: [(String, String)] = [
            ("App", version),
            ("Device", "\(machine), iOS \(UIDevice.current.systemVersion)"),
            ("Camera", cameraName()),
            ("Rotation coordinator", coordinatorState),
            ("Capture angle", "\(captureAngle)°"),
            ("Preview angle", "\(previewAngle)°"),
            ("Buffer rotation (data output)", "\(bufferAngle)°"),
            ("Frame turn", "\(turn)°"),
            ("Raw buffer", bufferSize.map { "\($0.w)×\($0.h)" } ?? "no frame yet"),
            ("Upright frame", upright.map { "\($0.w)×\($0.h) \($0.h > $0.w ? "portrait" : "landscape")" } ?? "–"),
            ("Stage", String(format: "%.3f (%@)", Double(stageAspect), portraitFrames ? "4:5 slot" : "4:3 slot")),
            ("Interface orientation", BoothCamera.name(BoothCamera.interfaceOrientation())),
            ("Device orientation", BoothCamera.name(UIDevice.current.orientation)),
            ("Mirrored preview", mirrored ? "yes" : "no"),
        ]
        rows += formatRows()
        return rows
    }

    private func logDiagnostics() {
        let line = diagnostics().map { "\($0.0)=\($0.1)" }.joined(separator: "; ")
        cameraLog.notice("camera start: \(line, privacy: .public)")
    }

    static func name(_ o: UIInterfaceOrientation) -> String {
        switch o {
        case .portrait: return "portrait"
        case .portraitUpsideDown: return "portrait upside down"
        case .landscapeLeft: return "landscape left (port left)"
        case .landscapeRight: return "landscape right (port right)"
        default: return "unknown"
        }
    }

    static func name(_ o: UIDeviceOrientation) -> String {
        switch o {
        case .portrait: return "portrait"
        case .portraitUpsideDown: return "portrait upside down"
        case .landscapeLeft: return "landscape left (port right)"
        case .landscapeRight: return "landscape right (port left)"
        case .faceUp: return "face up"
        case .faceDown: return "face down"
        default: return "unknown"
        }
    }

    #if targetEnvironment(simulator)
    // No camera in the Simulator: a fake sensor stands in, so the whole booth flow (capture → review →
    // print → archive) and the rotation path can be exercised. It is built from BoothCore's physical
    // model (SensorMount), and a fake coordinator reports that model's angles: the app's own fallback
    // table (Upright.builtInAngle) is not used to make or to read the frames.
    enum FakeCamera: String { case classic, connection180, portraitNative }
    let fakeMode = FakeCamera(rawValue: UserDefaults.standard.string(forKey: "booth.fakeCamera") ?? "") ?? .classic
    var fakeMount: SensorMount { facing == .back ? .back : fakeMode == .portraitNative ? .frontPortraitNative : .front }
    /// The fake data output's rotation: 0, except `connection180` (front), which keeps a 180° default
    /// whatever the booth asks (so the compensation path, not just the reset, is exercised).
    var fakeBufferAngle: Int { fakeMode == .connection180 && facing == .front ? 180 : 0 }

    @Published var fake: CGImage?
    private var fakeTimer: Timer?
    func start() {
        running = true; failed = false
        markStart()
        updateAngles()
        fakeTimer?.invalidate()
        fakeTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15, repeats: true) { [weak self] _ in
            guard let self else { return }
            updateAngles()   // the Simulator turns without KVO: follow it every frame
            let t = Date().timeIntervalSince1970
            lock.lock(); let a = angles; lock.unlock()
            let native = BoothCamera.fakeNative(t, mount: fakeMount)
            // The plain preview: the native frame turned by the preview angle, as the preview layer does.
            fake = rotate(native, a.preview)
            let delivered = rotate(native, a.buffer)
            sawFrame(delivered.width, delivered.height)
            live.offer(CIImage(cgImage: delivered), turn: Upright.frameTurn(capture: a.capture, buffer: a.buffer),
                       display: Upright.displayTurn(capture: a.capture, preview: a.preview))
        }
    }
    func stop() { fakeTimer?.invalidate(); running = false }
    func flip() { facing = facing == .front ? .back : .front; updateAngles() }
    private func configureCoordinator() { updateAngles() }
    /// The fake coordinator: the model's horizon angles for gravity (capture) and the interface (preview).
    private func updateAngles() {
        let m = fakeMount
        coordinatorState = "fake (\(fakeMode.rawValue))"
        setAngles(capture: m.horizonAngle(BoothCamera.deviceHold()), preview: m.horizonAngle(BoothCamera.interfaceHold()), buffer: fakeBufferAngle)
    }
    private func cameraName() -> String { "\(facing == .front ? "front" : "back") (Simulator fake, sensor top → \(fakeMount.up.rawValue) edge)" }
    private func formatRows() -> [(String, String)] { [] }
    private func sensorFrame() -> (CIImage, Int)? {
        lock.lock(); let a = angles; lock.unlock()
        let native = BoothCamera.fakeNative(Date().timeIntervalSince1970, mount: fakeMount, w: 1440, h: 1080)
        return (CIImage(cgImage: rotate(native, a.buffer)), Upright.frameTurn(capture: a.capture, buffer: a.buffer))
    }

    /// What the sensor `mount` sees of the fake scene, in its native orientation: the upright scene,
    /// turned counter-clockwise by the model's horizon angle for how gravity holds the device.
    /// `w`×`h` is a landscape sensor's size (swapped for a portrait-native one).
    static func fakeNative(_ t: Double, mount: SensorMount, w: Int = 480, h: Int = 360) -> CGImage {
        let angle = mount.horizonAngle(MainActor.assumeIsolated { deviceHold() })
        let (nw, nh) = mount.landscapeBuffer ? (w, h) : (h, w)
        let up = Upright.uprightSize(nw, nh, turn: angle)
        return rotate(scene(t, w: up.w, h: up.h), -angle)
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
        markStart()
        queue.async { [self] in
            if session.inputs.isEmpty || input?.device.position != facing { configure() }
            if !session.isRunning { session.startRunning() }
            DispatchQueue.main.async { self.running = self.session.isRunning }
        }
    }

    func stop() { queue.async { [self] in session.stopRunning(); DispatchQueue.main.async { self.running = false } } }

    func flip() {
        facing = facing == .front ? .back : .front
        markStart()
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

    /// The camera's static angle for `hold` (no coordinator, or no on-screen layer): iOS 27 asks the
    /// camera's coordinator (videoRotationAngleRelative(toDeviceOrientation:)); before that, a classic
    /// built-in camera's (Upright.builtInAngle).
    private static func staticAngle(_ coordinator: AVCaptureDevice.RotationCoordinator?, _ hold: Hold, front: Bool) -> Int {
        if #available(iOS 27.0, *), let c = coordinator, c.device != nil {
            let o: AVCaptureVideoOrientation
            switch hold {
            case .portrait: o = .portrait
            case .portraitUpsideDown: o = .portraitUpsideDown
            case .landscapeRight: o = .landscapeRight
            case .landscapeLeft: o = .landscapeLeft
            }
            return Upright.normalize(c.videoRotationAngleRelative(toDeviceOrientation: o))
        }
        return Upright.builtInAngle(hold, front: front)
    }

    /// Camera queue, inside a session configuration. A camera with a dynamic aspect ratio (iOS 26:
    /// e.g. a square sensor) delivers whatever ratio it starts on; ask for the 4:3 / 3:4 one whose
    /// upright frame is portrait when the device is held upright (the booth's 4:5 slot).
    private func pickAspectRatio(_ device: AVCaptureDevice, bufferAngle: Int) {
        guard #available(iOS 26.0, *) else { return }
        let supported = device.activeFormat.supportedDynamicAspectRatios
        guard !supported.isEmpty else { return }
        let probe = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
        let turn = Upright.frameTurn(capture: BoothCamera.staticAngle(probe, .portrait, front: device.position == .front), buffer: bufferAngle)
        // A landscape buffer (4x3) stands up portrait after a quarter turn; a portrait one (3x4) after none.
        let want: AVCaptureDevice.AspectRatio = Upright.isQuarter(turn) ? .ratio4x3 : .ratio3x4
        guard supported.contains(want), device.dynamicAspectRatio != want, (try? device.lockForConfiguration()) != nil else { return }
        device.setDynamicAspectRatio(want, completionHandler: nil)
        device.unlockForConfiguration()
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
        // Frames stay in the sensor's native orientation (turned here, in Core Image) and unmirrored.
        // `isVideoMirrored` may only be set once automatic mirroring is off (it throws otherwise),
        // and the rotation must be reset by hand: its default is not 0 on every camera
        // (AVCaptureSession.h videoRotationAngle). Whatever it ends up as is read back and allowed for.
        var buffer = 0
        if let c = output.connection(with: .video) {
            if c.isVideoMirroringSupported { c.automaticallyAdjustsVideoMirroring = false; c.isVideoMirrored = false }
            if c.isVideoRotationAngleSupported(0) { c.videoRotationAngle = 0 }
            buffer = Upright.normalize(c.videoRotationAngle)
        }
        pickAspectRatio(device, bufferAngle: buffer)
        lock.lock(); seenSize = nil; lock.unlock()
        DispatchQueue.main.async { self.failed = false; self.bufferAngle = buffer; self.bufferSize = nil; self.configureCoordinator() }
    }

    private var observations: [NSKeyValueObservation] = []
    /// Main thread. A coordinator for the current camera, with the preview layer only while that layer
    /// is in a window (otherwise its preview angle reads 0°): until then, the preview angle is the
    /// camera's static one for the interface orientation. Re-made when the camera flips or the layer changes.
    private func configureCoordinator() {
        guard let device = input?.device else { coordinator = nil; observations = []; updateAngles(); return }
        let layer = BoothCamera.inWindow(previewLayer) ? previewLayer : nil
        let c = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: layer)
        coordinator = c
        // KVO is delivered on the main queue (AVCaptureDevice.h); hop anyway, to read both angles together.
        observations = [
            c.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.updateAngles() } },
            c.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] _, _ in DispatchQueue.main.async { self?.updateAngles() } },
        ]
        updateAngles()
    }

    /// Main thread: read the angles from the coordinator (or the static fallback).
    private func updateAngles() {
        let device = input?.device, front = facing == .front
        let current = coordinator.flatMap { $0.device != nil && $0.device === device ? $0 : nil }
        let fb = (capture: BoothCamera.staticAngle(current, BoothCamera.deviceHold(), front: front),
                  preview: BoothCamera.staticAngle(current, BoothCamera.interfaceHold(), front: front))
        guard let c = current else {
            coordinatorState = "no"
            setAngles(capture: fb.capture, preview: fb.preview, buffer: bufferAngle); return
        }
        let capture = Upright.normalize(c.videoRotationAngleForHorizonLevelCapture)
        // Trust the preview angle only while the coordinator's layer is the live, on-screen one.
        let onScreen = c.previewLayer != nil && c.previewLayer === previewLayer && BoothCamera.inWindow(previewLayer)
        coordinatorState = onScreen ? "yes, with the on-screen preview layer" : "yes, no on-screen layer (preview angle from the static table)"
        let preview = onScreen ? Upright.normalize(c.videoRotationAngleForHorizonLevelPreview) : fb.preview
        setAngles(capture: capture, preview: preview, buffer: bufferAngle)
    }

    private func cameraName() -> String {
        guard let d = input?.device else { return "\(facing == .front ? "front" : "back") (no device)" }
        return "\(d.position == .front ? "front" : "back"), \(d.localizedName)"
    }

    private func formatRows() -> [(String, String)] {
        guard let d = input?.device else { return [] }
        let dims = CMVideoFormatDescriptionGetDimensions(d.activeFormat.formatDescription)
        var rows = [("Active format", "\(dims.width)×\(dims.height)")]
        if #available(iOS 26.0, *), !d.activeFormat.supportedDynamicAspectRatios.isEmpty {
            let dd = d.dynamicDimensions
            rows.append(("Dynamic aspect ratio", "\(d.dynamicAspectRatio?.rawValue ?? "none") (\(dd.width)×\(dd.height)); offers \(d.activeFormat.supportedDynamicAspectRatios.map(\.rawValue).joined(separator: ", "))"))
        }
        if #available(iOS 27.0, *) {
            rows.append(("Static angles (portrait / port right / port left)", [Hold.portrait, .landscapeRight, .landscapeLeft].map { "\(BoothCamera.staticAngle(coordinator, $0, front: d.position == .front))°" }.joined(separator: " / ")))
        }
        if d.position == .front { rows.append(("Center Stage", AVCaptureDevice.isCenterStageEnabled ? (d.isCenterStageActive ? "on, active" : "on") : "off")) }
        return rows
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sb: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        lock.lock(); latest = pb; let a = angles; lock.unlock()
        sawFrame(CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb))
        // The delivered frame; LivePreview stands it up (frame turn), crops + dithers, then turns the
        // dots to match the on-screen video. Not mirrored here: LiveDots mirrors the selfie view.
        live.offer(CIImage(cvPixelBuffer: pb), turn: Upright.frameTurn(capture: a.capture, buffer: a.buffer),
                   display: Upright.displayTurn(capture: a.capture, preview: a.preview))
    }

    private func sensorFrame() -> (CIImage, Int)? {
        lock.lock(); let pb = latest; let a = angles; lock.unlock()
        return pb.map { (CIImage(cvPixelBuffer: $0), Upright.frameTurn(capture: a.capture, buffer: a.buffer)) }
    }
    #endif

    /// The current frame, upright (frame turn), unmirrored: `full` at native size (archive) and
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

    /// A delivered frame turned upright by `angle` clockwise degrees, its extent at the origin.
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
