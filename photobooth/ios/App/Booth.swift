// The booth: index.html's script, natively. Screens, settings, the active
// party, capture → compose/dither preview → print → archive.

import SwiftUI
import Network
import BoothCore

enum Screen: Equatable { case lock, camera, review, printing, settings }

/// Per-device settings (index.html `cfg()`), in UserDefaults.
struct Settings {
    private let d = UserDefaults.standard
    /// The PIN an adult saved: typed at the lock screen or from a setup link. Wins over the bundled one.
    var pin: String { get { d.string(forKey: "booth.pin") ?? "" } nonmutating set { d.set(newValue, forKey: "booth.pin") } }
    /// The PIN compiled in from the gitignored Booth.local.xcconfig (Info.plist `BoothPIN`); "" without it.
    /// `-booth.ignoreBundledPin YES` (the UI test) pretends there is none.
    var bundledPin: String {
        if d.bool(forKey: "booth.ignoreBundledPin") { return "" }
        return (Bundle.main.object(forInfoDictionaryKey: "BoothPIN") as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
    }
    /// The bundled PIN the server last answered 401 to (rotated since the build). Not retried until
    /// it changes (a new build) or an adult clears it in settings.
    var rejectedBundledPin: String { get { d.string(forKey: "booth.bundledPinRejected") ?? "" } nonmutating set { d.set(newValue, forKey: "booth.bundledPinRejected") } }
    /// What goes in `x-booth-pin`: the saved PIN, else the bundled one (unless rejected), else "" (lock screen).
    var effectivePin: String {
        if !pin.isEmpty { return pin }
        let b = bundledPin
        return b != rejectedBundledPin ? b : ""
    }
    /// Info.plist `BoothServer` (Booth.local.xcconfig `BOOTH_SERVER`), else production.
    static let defaultServer: URL = (Bundle.main.object(forInfoDictionaryKey: "BoothServer") as? String)
        .flatMap { URL(string: $0.trimmingCharacters(in: .whitespaces)) }
        .flatMap { $0.scheme != nil && $0.host() != nil ? $0 : nil } ?? BoothAPI.production
    var server: URL {
        get { d.string(forKey: "booth.server").flatMap { URL(string: $0) }.flatMap { $0.scheme == nil ? nil : $0 } ?? Settings.defaultServer }
        nonmutating set { d.set(newValue.absoluteString, forKey: "booth.server") }
    }
    var theme: String { get { d.string(forKey: "booth.theme") ?? "stars" } nonmutating set { d.set(newValue, forKey: "booth.theme") } }
    var shots: Int { get { d.object(forKey: "booth.shots") as? Int ?? 3 } nonmutating set { d.set(newValue, forKey: "booth.shots") } }
    var footer: String { get { d.string(forKey: "booth.footer") ?? "" } nonmutating set { d.set(newValue, forKey: "booth.footer") } }
    var count: Int { get { min(10, max(1, d.object(forKey: "booth.count") == nil ? 3 : d.integer(forKey: "booth.count"))) } nonmutating set { d.set(newValue, forKey: "booth.count") } }
    var gain: Double { get { d.object(forKey: "booth.gain") as? Double ?? 0.15 } nonmutating set { d.set(newValue, forKey: "booth.gain") } }
    var density: Int { get { d.object(forKey: "booth.density") as? Int ?? 3 } nonmutating set { d.set(newValue, forKey: "booth.density") } }
    var speed: Int { get { d.object(forKey: "booth.speed") as? Int ?? 2 } nonmutating set { d.set(newValue, forKey: "booth.speed") } }
    var sound: Bool { get { d.object(forKey: "booth.sound") == nil ? true : d.bool(forKey: "booth.sound") } nonmutating set { d.set(newValue, forKey: "booth.sound") } }
    var ticket: Int { get { d.integer(forKey: "booth.ticket") } nonmutating set { d.set(newValue, forKey: "booth.ticket") } }
    var head: (sink: Double, t: Double)? {
        get { guard let a = d.array(forKey: "booth.head") as? [Double], a.count == 2 else { return nil }; return (a[0], a[1]) }
        nonmutating set { d.set(newValue.map { [$0.sink, $0.t] }, forKey: "booth.head") }
    }
    var event: BoothEvent? {
        get { d.data(forKey: "booth.event").flatMap { try? JSONDecoder().decode(BoothEvent.self, from: $0) } }
        nonmutating set { d.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "booth.event") }
    }
}

/// The shoot in progress (archive session + what review/print need).
struct Shoot {
    var id: String
    var capturedAt: Date
    var event: String?
    var frames: [CGImage]          // upright, ≤ 1440 px, for compose
    var full: [CGImage]            // upright, native size, for the archive
    var rotations: [Int]
    var faces: [[Box]]?            // per frame, in `frames` pixels (nil: detector not done)
    var seed: Int
    var sentRotations: [Int]? = nil
}

struct Preview { var bits: [UInt8]; var gray: [Float]; var layout: StripLayout; var image: CGImage }

@MainActor final class Booth: ObservableObject {
    let settings = Settings()
    let camera = BoothCamera()
    let archive = ArchiveQueue()
    private(set) var api: BoothAPI

    @Published var screen: Screen = .lock
    @Published var theme: String
    @Published var shots: Int
    @Published var party: BoothEvent?
    @Published var printer: PrinterHealth?
    @Published var busy = false
    @Published var shot: Shoot?
    @Published var preview: Preview?
    @Published var copies = 1
    @Published var faceCount: Int?
    @Published var copiesTouched = false
    // capture UI
    @Published var countdown: Int?          // big numeral during the ring
    @Published var ringProgress: Double = 0 // 0…1
    @Published var ringMode: RingMode = .idle
    @Published var flash = false
    @Published var dotsDone = 0
    // printing UI
    @Published var printing = PrintingState()
    @Published var celebrate: String?
    @Published var shutterLocked = false
    @Published var lockShake = 0
    @Published var status: String?

    enum RingMode { case idle, countdown, cooldown }
    struct PrintingState { var copies = 1, done = 0, position = 0, error = false, slip: CGImage? = nil, height = 0, go = 0 }

    private var printTimes: [Date] = []
    private var lastTouch = Date()
    private var idleTask: Task<Void, Never>?
    private var timers: [Task<Void, Never>] = []
    private let path = NWPathMonitor()

    init() {
        let pin = Settings().effectivePin
        api = BoothAPI(server: Settings().server, pin: pin)
        theme = Settings().theme; shots = Settings().shots; party = Settings().event
        Sfx.shared.enabled = settings.sound
        Task { await archive.start(api) }
        path.pathUpdateHandler = { [weak self] p in if p.status == .satisfied { Task { await self?.archive.kick(after: 2) } } }
        path.start(queue: .main)
        // With a PIN (saved or bundled), open straight to the camera and check the PIN
        // in the background; a 401 sends us to the lock screen.
        if !pin.isEmpty { startCamera(); Task { await unlock(pin, quiet: true) } }
        timers.append(Task { [weak self] in   // printer health while the camera is up
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(15)); if self?.screen == .camera { await self?.refreshPrinter() } }
        })
        timers.append(Task { [weak self] in   // the active party, once a minute when idle
            while !Task.isCancelled { try? await Task.sleep(for: .seconds(60)); if let s = self, s.screen == .camera, !s.busy { await s.refreshEvent() } }
        })
    }

    func touched() { lastTouch = Date() }

    // MARK: lock / pairing

    /// A setup / share link (or settings → Server). A link with a PIN saves it and opens straight
    /// to the camera, like a launch with a saved PIN; the PIN is checked in the background and a
    /// 401 falls back to the lock screen.
    func pair(server: URL, pin: String?) {
        settings.server = server; api.server = server
        Task { await archive.setAPI(api) }
        guard let pin, !pin.isEmpty else { return }
        if pin == settings.bundledPin { settings.pin = ""; settings.rejectedBundledPin = "" } else { settings.pin = pin }
        api.pin = pin
        if screen == .lock { startCamera() }
        Task { await unlock(pin, quiet: true) }
    }

    /// The links Settings → Share booth hands out (they carry this booth's PIN).
    var shareLinks: (web: URL, app: URL)? {
        let pin = api.pin
        guard !pin.isEmpty else { return nil }
        return (BoothLinks.web(server: settings.server, pin: pin), BoothLinks.app(server: settings.server, pin: pin))
    }

    /// Try a PIN. Typed / setup-link PINs are saved first (so they work offline); the bundled
    /// one never is (typing it clears a saved PIN, so the bundled one is used again). `quiet`: the launch / background check, already on the camera.
    func unlock(_ pin: String, quiet: Bool = false) async {
        let bundled = !pin.isEmpty && pin == settings.bundledPin
        settings.pin = bundled ? "" : pin
        api.pin = pin
        await archive.setAPI(api)
        do {
            try await api.unlock()
            if bundled { settings.rejectedBundledPin = "" }   // the server took it back
            if !quiet { Sfx.shared.play("yay") }
            if screen == .lock { startCamera() }
            await archive.kick(after: 3)
        } catch BoothAPIError.locked {
            if !quiet { Sfx.shared.play("boo"); lockShake += 1 }
            rejected(pin)
        } catch {
            // Offline at the party: trust the cached PIN; prints will retry.
            if quiet { if screen == .lock { startCamera() } } else { Sfx.shared.play("boo"); lockShake += 1 }
        }
    }

    /// The server said 401 to `pin`: forget it (a saved PIN is cleared, a bundled one is marked
    /// rejected so it isn't retried in a loop), then fall back to what's left, or the lock screen.
    private func rejected(_ pin: String) {
        guard pin == api.pin else { return }   // a later 401 for a PIN already dropped or replaced
        if pin == settings.pin { settings.pin = "" }
        if !pin.isEmpty, pin == settings.bundledPin { settings.rejectedBundledPin = pin }
        let next = settings.effectivePin
        api.pin = next
        Task { await archive.setAPI(api) }
        if !next.isEmpty, next != pin { Task { await unlock(next, quiet: true) } } else { showLock() }
    }

    private func showLock() { camera.stop(); screen = .lock }

    /// Settings: with no bundled PIN, "Lock booth" (forget the PIN, back to the lock screen).
    /// With one, "Forget saved PIN": back to the bundled PIN, checked in the background.
    func forgetSavedPin() {
        settings.pin = ""; settings.rejectedBundledPin = ""
        let next = settings.effectivePin
        api.pin = next
        Task { await archive.setAPI(api) }
        if next.isEmpty { showLock() } else { Task { await unlock(next, quiet: true) } }
    }

    /// `pin`: what the failed request carried (`api.pin` may have moved on since).
    private func handle(_ e: Error, pin: String) { if case BoothAPIError.locked = e { rejected(pin) } }

    // MARK: camera screen

    func startCamera() {
        screen = .camera
        applyTheme()
        UIApplication.shared.isIdleTimerDisabled = true
        camera.start()
        Task { await refreshPrinter(); await refreshEvent() }
    }

    var offeredThemes: [String] {
        let want = party?.themes.filter { THEMES[$0] != nil } ?? []
        return want.isEmpty ? THEME_ORDER : want
    }
    var footerText: String { party?.footer?.isEmpty == false ? party!.footer! : settings.footer }

    func applyTheme() {
        let offered = offeredThemes
        if !offered.contains(theme) { setTheme(party?.theme.flatMap { offered.contains($0) ? $0 : nil } ?? offered[0]) }
    }
    func setTheme(_ t: String) { theme = t; settings.theme = t }
    func toggleShots() { shots = shots == 3 ? 1 : 3; settings.shots = shots; Sfx.shared.play("boop") }

    func refreshEvent() async {
        let pin = api.pin
        do {
            let ev = try await api.activeEvent()
            let prev = party?.slug
            party = ev; settings.event = ev
            if ev?.slug != prev, let t = ev?.theme { setTheme(t) }
            applyTheme()
        } catch { handle(error, pin: pin) }
    }

    private var lastHealthNudge = Date.distantPast
    func refreshPrinter() async {
        guard let h = try? await api.printer() else { return }
        printer = h
        // With MQTT the printer barely polls on its own; while the booth is in use,
        // ask it to check in (refreshes paper/cover status) at most every 2 min.
        if Date().timeIntervalSince(lastTouch) < 600, (h.lastSeenSec ?? 1_000_000) > 120, Date().timeIntervalSince(lastHealthNudge) > 120 {
            lastHealthNudge = Date()
            await api.nudge()
            try? await Task.sleep(for: .seconds(3))
            if let h2 = try? await api.printer() { printer = h2 }
        }
    }

    // MARK: capture

    private func ring(_ mode: RingMode, seconds: Double) async {
        ringMode = mode; ringProgress = 0
        let t0 = Date(); var last = -1
        while true {
            let p = min(1, Date().timeIntervalSince(t0) / seconds)
            ringProgress = p
            if mode == .countdown {
                let left = max(1, Int((seconds - Date().timeIntervalSince(t0)).rounded(.up)))
                if left != last { last = left; countdown = left; Sfx.shared.tick(left); buzz(.light) }
            }
            if p >= 1 { break }
            try? await Task.sleep(for: .milliseconds(16))
        }
        ringMode = .idle; countdown = nil
    }

    func shutter() async {
        guard !busy, !shutterLocked, camera.running else { return }
        touched(); busy = true; Sfx.shared.play("tap")
        defer { busy = false; dotsDone = 0 }
        var frames: [CGImage] = [], full: [CGImage] = []
        dotsDone = 0
        for i in 0..<shots {
            await ring(.countdown, seconds: Double(settings.count))
            guard let g = camera.grab() else { Sfx.shared.play("boo"); return }
            frames.append(g.frame); full.append(g.full)
            Sfx.shared.play("snap"); buzz(.heavy)
            flash = true; try? await Task.sleep(for: .milliseconds(70)); flash = false
            dotsDone = i + 1
            if i < shots - 1 { try? await Task.sleep(for: .milliseconds(700)) }
        }
        var s = Shoot(id: newSessionId(), capturedAt: Date(), event: party?.slug, frames: frames, full: full,
                      rotations: Array(repeating: 0, count: frames.count), faces: nil, seed: Int(Int32.random(in: 0...Int32.max)))
        copies = 1; faceCount = nil; copiesTouched = false
        // Faces: usually instant; wait briefly so copies + tone are ready at review.
        let faceTask = Task.detached { await detectFaces(frames) }
        let early = await withTaskGroup(of: [[Box]]?.self) { g -> [[Box]]? in
            g.addTask { await faceTask.value }
            g.addTask { try? await Task.sleep(for: .milliseconds(1200)); return nil }
            let first = await g.next() ?? nil; g.cancelAll(); return first
        }
        if let f = early { s.faces = f; setFaceDefaults(f) }
        shot = s
        await buildPreview()
        screen = .review; armIdle()
        syncOriginals()
        if early == nil {
            let f = await faceTask.value
            guard shot?.id == s.id else { return }
            shot?.faces = f; setFaceDefaults(f)
            if f.contains(where: { !$0.isEmpty }), screen == .review { await buildPreview() }
        }
    }

    private func setFaceDefaults(_ f: [[Box]]) {
        let counts = f.map(\.count)
        faceCount = maxFaces(counts)
        if !copiesTouched { copies = defaultCopies(counts) }
    }

    func bumpCopies(_ d: Int) {
        armIdle(); touched()
        let n = copies + d
        guard (MIN_COPIES...MAX_COPIES).contains(n) else { Sfx.shared.play("boo"); return }
        copiesTouched = true; Sfx.shared.play(d > 0 ? "tap" : "boop"); copies = n
    }

    var headHeatNow: Double {
        guard let h = settings.head else { return 0 }
        return headHeat(sink: h.sink, at: h.t, now: Date().timeIntervalSince1970)
    }

    func qrURL(_ s: Shoot) -> String {
        guard let p = party, p.qr, let share = p.share, !share.isEmpty, s.event == p.slug else { return "" }
        return api.albumURL(share: share, session: s.id)
    }

    func buildPreview() async {
        guard let s = shot else { return }
        var o = ComposeOptions()
        o.theme = theme; o.seed = s.seed; o.footer = footerText; o.ticket = settings.ticket + 1
        o.date = StubDate(s.capturedAt); o.qr = qrURL(s)
        let upright = zip(s.frames, s.rotations).map { rotate($0, $1) }
        if let f = s.faces { o.faces = zip(zip(s.frames, f), s.rotations).map { rotateBoxes($0.1, Double($0.0.width), Double($0.0.height), $1) } }
        let gain = settings.gain, sink = headHeatNow
        let p = await Task.detached(priority: .userInitiated) { () -> Preview in
            let (canvas, L) = compose(upright, o)
            let gray = luminance(canvas.getImageData(), PRINT_WIDTH, L.H)
            let bits = ditherStrip(gray, w: PRINT_WIDTH, h: L.H, segments: stripSegments(L, gain: gain), copies: 1, sinkStart: sink).bits[0]
            return Preview(bits: bits, gray: gray, layout: L, image: thermalImage(bits, L.H))
        }.value
        if shot?.id == s.id { preview = p }
    }

    func rotatePhoto(_ i: Int) async {
        guard shot != nil, i < shot!.rotations.count else { return }
        Sfx.shared.play("boop"); armIdle()
        shot!.rotations[i] = (shot!.rotations[i] + 90) % 360
        await buildPreview()
    }

    func retake() { Sfx.shared.play("boop"); idleTask?.cancel(); syncOriginals(); screen = .camera }

    private func armIdle() {
        idleTask?.cancel()
        idleTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(45))
            guard let self, !Task.isCancelled, self.screen == .review else { return }
            self.syncOriginals(); self.screen = .camera
        }
    }

    // MARK: archive

    private func meta(_ s: Shoot, printed: Bool = false, copies: Int? = nil) -> ArchiveMeta {
        var m = ArchiveMeta(id: s.id)
        m.capturedAt = ISO8601DateFormatter().string(from: s.capturedAt)
        m.theme = theme; m.shots = s.full.count
        m.faces = s.faces?.map { $0.count }; m.rotations = s.rotations; m.mirrored = false
        m.ticket = settings.ticket + 1; m.ua = "receiptd-booth-ios/\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?") \(UIDevice.current.model) iOS \(UIDevice.current.systemVersion)"
        m.printed = printed; m.event = s.event; m.copies = copies
        return m
    }

    /// (Re-)queue the originals unless already queued with the current ↻ rotations.
    func syncOriginals() {
        guard var s = shot, s.sentRotations != s.rotations else { return }
        s.sentRotations = s.rotations; shot = s
        let m = meta(s), archive = archive
        Task.detached(priority: .utility) {
            try? await Task.sleep(for: .milliseconds(600))   // review screen + dither first
            var files: [String: Data] = [:], bytes: [String: Int] = [:]
            for (i, f) in s.full.enumerated() {
                guard let jpg = encodeArchiveJPEG(rotate(f, s.rotations[i])) else { continue }
                files["orig-\(i + 1).jpg"] = jpg; bytes["orig-\(i + 1).jpg"] = jpg.count
            }
            var mm = m; mm.bytes = bytes
            await archive.enqueue(mm, files: files)
        }
    }

    // MARK: print

    func printStrip() async {
        guard let s = shot, let pv = preview else { return }
        idleTask?.cancel(); touched()
        Sfx.shared.play("whirr")
        let n = copies
        printing = PrintingState(copies: n, done: 0, position: 0, error: false, slip: pv.image, height: pv.layout.H, go: printing.go + 1)
        screen = .printing
        await archive.pause()   // the print request gets the Wi-Fi to itself
        let pin = api.pin
        do {
            // Re-render every copy from the head heat right now.
            let segs = stripSegments(pv.layout, gain: settings.gain), sink = headHeatNow, gray = pv.gray, H = pv.layout.H
            let r = await Task.detached(priority: .userInitiated) { ditherStrip(gray, w: PRINT_WIDTH, h: H, segments: segs, copies: n, sinkStart: sink) }.value
            let job = try await api.print(bits: r.bits, height: H, density: settings.density, speed: settings.speed)
            await archive.resume()
            let png = encodeBitPNG(r.bits[0], PRINT_WIDTH, H)
            var m = meta(s, printed: true, copies: n); m.bytes = ["strip.png": png.count]
            await archive.enqueue(m, files: ["strip.png": png])
            syncOriginals()
            settings.head = (r.sink, Date().timeIntervalSince1970)
            settings.ticket += 1
            for _ in 0..<n { printTimes.append(Date()) }
            await waitForJob(job.id, copies: n, height: H)
            celebrate = ["🎉", "🥳", "🤩", "😻", "🦄"].randomElement()
            Sfx.shared.play("yay")
            try? await Task.sleep(for: .seconds(2.4))
            celebrate = nil
            screen = .camera
            shutterLocked = true
            printTimes.removeAll { Date().timeIntervalSince($0) > 60 }
            await ring(.cooldown, seconds: cooldownSeconds(recentPrints: printTimes.count))
            shutterLocked = false
        } catch {
            await archive.resume()
            handle(error, pin: pin)
            if screen == .printing { Sfx.shared.play("boo"); printing.error = true }
        }
    }

    private func waitForJob(_ id: String, copies n: Int, height: Int) async {
        let until = Date().addingTimeInterval(60 + 30 * Double(n))
        let perCopy = 1.5 + Double(height) * 0.002
        var printingSince: Date?, shown = 0, nudges = 0
        let sent = Date()
        while Date() < until {
            // Not done after ~6 s (+ print time)? Re-send the MQTT poke, up to 5 times.
            if nudges < 5, Date().timeIntervalSince(sent) > 6 * Double(nudges + 1) + perCopy * Double(n - 1) {
                nudges += 1; Task { await api.nudge() }
            }
            if let s = try? await api.job(id) {
                if let p = s.printer { printer = p }
                if s.status == "completed" { printing.done = n; return }
                if s.status == "printing", n > 1 {
                    printingSince = printingSince ?? Date()
                    let est = min(n - 1, Int(Date().timeIntervalSince(printingSince!) / perCopy))
                    if est > shown { shown = est; printing.done = est; Sfx.shared.play("whirr"); buzz(.medium); printing.go += 1 }
                }
                printing.position = s.position ?? 0
            }
            try? await Task.sleep(for: .seconds(1))
        }
    }

    func printRetry() async { Sfx.shared.play("tap"); await printStrip() }
    func printBack() { Sfx.shared.play("boop"); screen = .camera }

    // MARK: app lifecycle

    private var bgTask: UIBackgroundTaskIdentifier = .invalid
    func phaseChanged(_ p: ScenePhase) {
        switch p {
        case .active:
            Task { await archive.kick(after: 5) }
            if screen == .camera { camera.start() }
        case .background:
            // Give queued uploads a little time to finish before iOS suspends us.
            bgTask = UIApplication.shared.beginBackgroundTask { [weak self] in self.map { UIApplication.shared.endBackgroundTask($0.bgTask) } }
            Task { await archive.flush(); UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
        default: break
        }
    }

    // MARK: settings

    func openSettings() { status = nil; screen = .settings; Task { await refreshEvent() } }
    func closeSettings() { Sfx.shared.enabled = settings.sound; startCamera() }

    func printCalibration() async {
        status = "Printing calibration strip…"
        let (gray, H, bandH) = await Task.detached { calibrationGray(CALIBRATION_GAINS) }.value
        let bits = await Task.detached { ditherStrip(gray, w: PRINT_WIDTH, h: H, segments: calibrationSegments(H: H, bandH: bandH)).bits }.value
        let pin = api.pin
        do { _ = try await api.print(bits: bits, height: H, density: settings.density, speed: settings.speed)
            status = "Sent. Pick the band (A–E) with the most even greys below the black block."
        } catch { handle(error, pin: pin); status = "Failed: \(error)" }
    }
}

/// The preview bitmap, tinted like receipt paper (ink 26, paper cream).
func thermalImage(_ bits: [UInt8], _ h: Int) -> CGImage {
    var px = [UInt8](repeating: 0, count: PRINT_WIDTH * h * 4)
    for i in 0..<bits.count {
        let v: UInt8 = bits[i] != 0 ? 26 : 255
        px[i * 4] = v; px[i * 4 + 1] = v &- 6; px[i * 4 + 2] = bits[i] != 0 ? 35 : 255; px[i * 4 + 3] = 255
    }
    let ctx = CGContext(data: &px, width: PRINT_WIDTH, height: h, bitsPerComponent: 8, bytesPerRow: PRINT_WIDTH * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return ctx.makeImage()!
}
