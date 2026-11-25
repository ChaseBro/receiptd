// Kid screens: emoji, shapes and numerals only (words are accessibility
// labels). Adult settings are behind a 1.5 s long-press on the top-right corner.

import SwiftUI
import BoothCore

struct BoothView: View {
    @StateObject var booth = Booth()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        let (a, _) = THEME_ACCENTS[booth.theme] ?? (.sun, .grape)
        ZStack {
            PaperBackground(accent: a)
            switch booth.screen {
            case .lock: LockScreen()
            case .camera: CameraScreen()
            case .review: ReviewScreen()
            case .printing: PrintingScreen()
            case .settings: SettingsScreen()
            }
            if let face = booth.celebrate { DoneOverlay(face: face) }
        }
        .environmentObject(booth)
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onOpenURL { url in if let p = Pairing(url: url) { booth.pair(server: p.server, pin: p.key) } }
        // Not on settings: a root tap gesture swallows Form row taps (buttons, links, ShareLink).
        .simultaneousGesture(TapGesture().onEnded { booth.touched() }, including: booth.screen == .settings ? .subviews : .all)
        .onChange(of: phase) { _, p in booth.phaseChanged(p) }
    }
}

// MARK: lock (adult)

struct LockScreen: View {
    @EnvironmentObject var booth: Booth
    @State private var pin = ""
    @FocusState private var focused: Bool
    var body: some View {
        VStack(spacing: 28) {
            Sticker(fill: .sun, corner: 999, line: LINE_FAT, tilt: -6) { Emoji("📸", size: 90).padding(28) }
            HStack(spacing: 16) {
                SecureField("", text: $pin)
                    .keyboardType(.numberPad).focused($focused)
                    .font(Fonts.display(40)).multilineTextAlignment(.center)
                    .frame(width: 220, height: 72)
                    .background(RoundedRectangle(cornerRadius: 20).fill(.white))
                    .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.ink, lineWidth: LINE))
                    .accessibilityLabel("PIN")
                    .onSubmit(go)
                Button(action: go) { Emoji("🔓", size: 44).frame(width: 80, height: 72) }
                    .buttonStyle(StickerStyle(fill: .mint)).accessibilityLabel("Unlock")
            }
            .modifier(Shake(n: booth.lockShake))
            Text("Booth: \(booth.settings.server.host() ?? "")").font(.footnote).foregroundStyle(Color.ink.opacity(0.5))
        }
        .onAppear { focused = true }
    }
    func go() { let p = pin.trimmingCharacters(in: .whitespaces); pin = ""; Task { await booth.unlock(p) } }
}

struct Shake: GeometryEffect {
    var n: Int
    var animatableData: CGFloat
    init(n: Int) { self.n = n; animatableData = CGFloat(n) }
    func effectValue(size: CGSize) -> ProjectionTransform { ProjectionTransform(CGAffineTransform(translationX: 14 * sin(animatableData * .pi * 4), y: 0)) }
}

// MARK: camera

struct CameraScreen: View {
    @EnvironmentObject var booth: Booth
    @State private var bounce = false
    var body: some View {
        let (a, b) = THEME_ACCENTS[booth.theme] ?? (.sun, .grape)
        GeometryReader { geo in
            let landscape = geo.size.width > geo.size.height
            let layout = landscape ? AnyLayout(HStackLayout(spacing: 20)) : AnyLayout(VStackLayout(spacing: 18))
            layout {
                themePicker(landscape: landscape)
                ZStack {
                    stage(accent: a)
                    RingView().allowsHitTesting(false)
                }
                tray(accent: b, landscape: landscape)
            }
            .padding(20)
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .overlay(alignment: .topTrailing) { Hotspot() }
        .overlay { if booth.flash { Color.white.ignoresSafeArea() } }
        .onAppear { booth.applyTheme() }
    }

    func themePicker(landscape: Bool) -> some View {
        let l = landscape ? AnyLayout(VStackLayout(spacing: 14)) : AnyLayout(HStackLayout(spacing: 14))
        return ScrollView(landscape ? .vertical : .horizontal, showsIndicators: false) {
            l {
                ForEach(booth.offeredThemes, id: \.self) { k in
                    let sel = k == booth.theme
                    Button { Sfx.shared.play("tap"); booth.setTheme(k) } label: { Emoji(THEMES[k]!.icon, size: 40).frame(width: 72, height: 72) }
                        .buttonStyle(StickerStyle(fill: sel ? (THEME_ACCENTS[k]?.0 ?? .sun) : .white, corner: 20, tilt: sel ? -4 : 0))
                        .scaleEffect(sel ? 1.12 : 1).animation(.spring(response: 0.3, dampingFraction: 0.45), value: sel)
                        .accessibilityLabel("\(k) theme")
                }
            }.padding(12)
        }
        .frame(maxWidth: landscape ? 110 : .infinity, maxHeight: landscape ? .infinity : 110)
    }

    func stage(accent: Color) -> some View {
        ZStack(alignment: .top) {
            Color.black.overlay(CameraPreview(camera: booth.camera))   // size from layout, not the view's intrinsic size
                .overlay(LiveDots(camera: booth.camera))                  // live print preview (when on)
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(Color.ink, lineWidth: LINE_FAT))
                .background(RoundedRectangle(cornerRadius: 28).fill(Color.ink).offset(x: 8, y: 8))
            if booth.ringMode == .idle, !booth.busy {   // 📤 Share booth, top-left of the stage (grown-ups)
                ShareButton().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(14)
            }
            if booth.shots > 1 {
                HStack(spacing: 10) {
                    ForEach(0..<booth.shots, id: \.self) { i in
                        Circle().fill(i < booth.dotsDone ? accent : .white).frame(width: 22, height: 22).overlay(Circle().stroke(Color.ink, lineWidth: 3))
                    }
                }.padding(.top, 14)
            }
            if booth.camera.failed {
                VStack(spacing: 18) {
                    Sticker(fill: .white, corner: 999) { Emoji("🙈", size: 70).padding(20) }
                    Button { booth.startCamera() } label: { Emoji("🔁", size: 44).frame(width: 90, height: 90) }.buttonStyle(StickerStyle(fill: .sun)).accessibilityLabel("Try again")
                }.frame(maxHeight: .infinity)
            }
            if let s = booth.printer?.sticker {
                Sticker(fill: .tomato, corner: 999, line: LINE_FAT, tilt: 8) { Emoji(s, size: 48).padding(14) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing).padding(16)
                    .accessibilityLabel(s == "🧻" ? "Printer out of paper" : "Printer problem")
            }
        }
    }

    func tray(accent: Color, landscape: Bool) -> some View {
        let l = landscape ? AnyLayout(VStackLayout(spacing: 26)) : AnyLayout(HStackLayout(spacing: 26))
        return l {
            Button { booth.toggleShots() } label: { StripIcon(shots: booth.shots).frame(width: 80, height: 80) }
                .buttonStyle(StickerStyle(fill: .white, corner: 20)).accessibilityLabel(booth.shots == 1 ? "One photo" : "Three photos")
            Button { Task { await booth.shutter() } } label: { Emoji("📸", size: 74).frame(width: 150, height: 150) }
                .buttonStyle(StickerStyle(fill: accent, corner: 999, line: LINE_FAT, shadow: 8))
                .disabled(booth.busy || booth.shutterLocked)
                .scaleEffect(bounce ? 1.06 : 0.96)
                .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { bounce = true } }
                .accessibilityLabel("Take photo")
            Button { Sfx.shared.play("boop"); booth.camera.flip() } label: { Emoji("🔄", size: 40).frame(width: 80, height: 80) }
                .buttonStyle(StickerStyle(fill: .white, corner: 20)).accessibilityLabel("Switch camera")
        }
    }
}

/// Long-press the top-right corner for 1.5 s → adult settings.
struct Hotspot: View {
    @EnvironmentObject var booth: Booth
    var body: some View {
        Color.clear.frame(width: 90, height: 90).contentShape(Rectangle())
            .onLongPressGesture(minimumDuration: 1.5) { booth.openSettings() }
            .accessibilityHidden(true)
    }
}

/// Countdown fills the ring; cooldown drains it.
struct RingView: View {
    @EnvironmentObject var booth: Booth
    var body: some View {
        if booth.ringMode != .idle {
            let p = booth.ringProgress
            ZStack {
                Color.ink.opacity(booth.ringMode == .countdown ? 0.25 + 0.5 * p : 0.6 * (1 - p)).clipShape(RoundedRectangle(cornerRadius: 28))
                Circle().stroke(Color.white.opacity(0.5), lineWidth: 22).frame(width: 220, height: 220)
                Circle().trim(from: 0, to: booth.ringMode == .countdown ? p : 1 - p)
                    .stroke(THEME_ACCENTS[booth.theme]?.0 ?? .sun, style: StrokeStyle(lineWidth: 22, lineCap: .round))
                    .rotationEffect(.degrees(-90)).frame(width: 220, height: 220)
                if let n = booth.countdown {
                    Text("\(n)").font(Fonts.display(130)).foregroundStyle(.white)
                        .shadow(color: .ink, radius: 0, x: 6, y: 6).id(n)
                        .transition(.scale(scale: 1.8).combined(with: .opacity))
                } else if booth.ringMode == .cooldown { Emoji("🎉", size: 90) }
            }
            .animation(.spring(response: 0.25, dampingFraction: 0.5), value: booth.countdown)
        }
    }
}

// MARK: review

struct ReviewScreen: View {
    @EnvironmentObject var booth: Booth
    var body: some View {
        GeometryReader { geo in
            let landscape = geo.size.width > geo.size.height
            let l = landscape ? AnyLayout(HStackLayout(spacing: 30)) : AnyLayout(VStackLayout(spacing: 20))
            l {
                receipt.frame(maxWidth: landscape ? geo.size.width * 0.45 : .infinity, maxHeight: .infinity)
                actions
            }.padding(24).frame(width: geo.size.width, height: geo.size.height)
        }
    }

    /// The whole strip, fitted to the space (the exact bitmap that prints), with ↻ per photo.
    var receipt: some View {
        Group {
            if let p = booth.preview {
                let ratio = CGFloat(PRINT_WIDTH) / CGFloat(p.layout.H)
                Image(decorative: p.image, scale: 1).resizable().interpolation(.medium)
                    .aspectRatio(ratio, contentMode: .fit)
                    .background(Color.white)
                    .mask(ZigZagPaper())
                    .background(ZigZagPaper().fill(Color.ink).offset(x: 6, y: 6))
                    .overlay {
                        GeometryReader { g in
                            let k = g.size.width / CGFloat(PRINT_WIDTH)
                            ForEach(Array(p.layout.photos.enumerated()), id: \.offset) { i, ph in
                                Button { Task { await booth.rotatePhoto(i) } } label: { Emoji("↻", size: 30).frame(width: 60, height: 60) }
                                    .buttonStyle(StickerStyle(fill: .white, corner: 999))
                                    .position(x: g.size.width + 18, y: (ph.y + ph.h / 2) * k)
                                    .accessibilityLabel("Rotate photo")
                            }
                        }
                    }
                    .padding(.trailing, 50)
                    .rotationEffect(.degrees(-1.5))
            } else { ProgressView().controlSize(.large) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    var actions: some View {
        VStack(spacing: 26) {
            VStack(spacing: 8) {
                HStack(spacing: 2) { ForEach(0..<min(booth.faceCount ?? 0, 8), id: \.self) { _ in Emoji("🙂", size: 28) } }.accessibilityHidden(true)
                HStack(spacing: 14) {
                    Button { booth.bumpCopies(-1) } label: { Emoji("➖", size: 30).frame(width: 72, height: 72) }
                        .buttonStyle(StickerStyle(fill: .white, corner: 999)).opacity(booth.copies <= 1 ? 0.4 : 1).accessibilityLabel("Fewer copies")
                    Sticker(fill: .sun, corner: 20) {
                        HStack(spacing: 4) { Emoji("🧾", size: 36); Text("×\(booth.copies)").font(Fonts.display(40)).foregroundStyle(Color.ink) }
                            .padding(.horizontal, 16).frame(height: 80)
                    }
                    .accessibilityElement().accessibilityLabel("\(booth.copies) \(booth.copies == 1 ? "copy" : "copies")")
                    Button { booth.bumpCopies(1) } label: { Emoji("➕", size: 30).frame(width: 72, height: 72) }
                        .buttonStyle(StickerStyle(fill: .white, corner: 999)).opacity(booth.copies >= MAX_COPIES ? 0.4 : 1).accessibilityLabel("More copies")
                }
            }
            HStack(spacing: 30) {
                Button { booth.retake() } label: { Emoji("✖️", size: 54).frame(width: 120, height: 120) }
                    .buttonStyle(StickerStyle(fill: .tomato, corner: 999, line: LINE_FAT)).accessibilityLabel("Retake")
                Button { Task { await booth.printStrip() } } label: { Emoji("🖨️", size: 64).frame(width: 150, height: 150) }
                    .buttonStyle(StickerStyle(fill: .mint, corner: 999, line: LINE_FAT, shadow: 8)).accessibilityLabel("Print")
                    .disabled(booth.preview == nil)
            }
        }
    }
}

/// Receipt paper with torn zig-zag top and bottom.
struct ZigZagPaper: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path(); let t: CGFloat = 14, d: CGFloat = 7
        p.move(to: CGPoint(x: 0, y: d))
        var x: CGFloat = 0
        while x < r.width { p.addLine(to: CGPoint(x: x + t / 2, y: 0)); p.addLine(to: CGPoint(x: min(r.width, x + t), y: d)); x += t }
        p.addLine(to: CGPoint(x: r.width, y: r.height - d))
        x = r.width
        while x > 0 { p.addLine(to: CGPoint(x: x - t / 2, y: r.height)); p.addLine(to: CGPoint(x: max(0, x - t), y: r.height - d)); x -= t }
        p.closeSubpath(); return p
    }
}

// MARK: printing

struct PrintingScreen: View {
    @EnvironmentObject var booth: Booth
    @State private var feed: CGFloat = 0
    var body: some View {
        let st = booth.printing
        VStack(spacing: 30) {
            ZStack(alignment: .top) {
                // the slip feeding out of the printer
                if let img = st.slip {
                    Image(decorative: img, scale: 1).resizable().interpolation(.none).aspectRatio(contentMode: .fit)
                        .frame(width: 216)
                        .frame(height: 360 * feed, alignment: .top).clipped()
                        .background(Color.white).mask(ZigZagPaper())
                        .shadow(color: .ink, radius: 0, x: 5, y: 5)
                        .offset(y: 120)
                }
                Sticker(fill: THEME_ACCENTS[booth.theme]?.0 ?? .sun, corner: 30, line: LINE_FAT, shadow: 8) {
                    HStack(spacing: 14) { Emoji(st.error ? "😕" : "😺", size: 64); Circle().fill(st.error ? Color.tomato : .mint).frame(width: 22, height: 22).overlay(Circle().stroke(Color.ink, lineWidth: 3)) }
                        .frame(width: 280, height: 130)
                }
            }
            .frame(height: 500, alignment: .top)
            .onAppear { feed = 0; withAnimation(.easeOut(duration: 3)) { feed = 1 } }
            .onChange(of: st.go) { feed = 0.2; withAnimation(.easeOut(duration: 2.5)) { feed = 1 } }

            if st.copies > 1 {
                HStack(spacing: 12) {
                    ForEach(0..<st.copies, id: \.self) { i in
                        Sticker(fill: i < st.done ? .mint : .white, corner: 16) { Emoji("🧾", size: 30).padding(8) }
                            .offset(y: i == st.done ? -8 : 0)
                            .animation(.easeInOut(duration: 0.5).repeatForever(), value: st.done)
                    }
                }.accessibilityHidden(true)
            }
            if st.position > 1 {
                HStack(spacing: 8) { Emoji("⏳", size: 30); ForEach(0..<min(4, st.position - 1), id: \.self) { _ in Emoji("🧾", size: 26) } }
            }
            if let s = booth.printer?.sticker { Sticker(fill: .tomato, corner: 999) { Emoji(s + "❗", size: 44).padding(14) } }
            if st.error {
                HStack(spacing: 30) {
                    Button { booth.printBack() } label: { Emoji("✖️", size: 44).frame(width: 100, height: 100) }.buttonStyle(StickerStyle(fill: .tomato, corner: 999)).accessibilityLabel("Back")
                    Button { Task { await booth.printRetry() } } label: { Emoji("🔁", size: 44).frame(width: 100, height: 100) }.buttonStyle(StickerStyle(fill: .sun, corner: 999)).accessibilityLabel("Try again")
                }
            }
        }
    }
}

struct DoneOverlay: View {
    let face: String
    @State private var pop = false
    var body: some View {
        ZStack {
            Confetti()
            Sticker(fill: .sun, corner: 999, line: LINE_FAT, shadow: 10, tilt: -8) { Emoji(face, size: 120).padding(40) }
                .scaleEffect(pop ? 1 : 0.2).animation(.spring(response: 0.35, dampingFraction: 0.45), value: pop)
        }
        .allowsHitTesting(false)
        .onAppear { pop = true }
    }
}

struct Confetti: View {
    @State private var t0 = Date()
    private let pieces = (0..<48).map { i in (x: Double.random(in: 0...1), s: Double.random(in: 12...28), d: Double.random(in: 1.6...3.2), dx: Double.random(in: -0.15...0.15), delay: Double.random(in: 0...0.35), c: Color.candy[i % 6], shape: i % 3) }
    var body: some View {
        TimelineView(.animation) { tl in
            SwiftUI.Canvas { ctx, size in
                let t = tl.date.timeIntervalSince(t0)
                for p in pieces {
                    let k = (t - p.delay) / p.d
                    guard k > 0, k < 1 else { continue }
                    let x = (p.x + p.dx * k) * size.width, y = -40 + k * (size.height + 80)
                    let r = CGRect(x: x, y: y, width: p.s, height: p.s)
                    var c = ctx; c.translateBy(x: r.midX, y: r.midY); c.rotate(by: .radians(k * 12)); c.translateBy(x: -r.midX, y: -r.midY)
                    let path = p.shape == 0 ? Path(r) : p.shape == 1 ? Path(ellipseIn: r) : Path { q in q.move(to: CGPoint(x: r.midX, y: r.minY)); q.addLine(to: CGPoint(x: r.maxX, y: r.maxY)); q.addLine(to: CGPoint(x: r.minX, y: r.maxY)); q.closeSubpath() }
                    c.fill(path, with: .color(p.c)); c.stroke(path, with: .color(.ink), lineWidth: 2)
                }
            }
        }.ignoresSafeArea()
    }
}

// MARK: settings (adult: words allowed)

struct SettingsScreen: View {
    @EnvironmentObject var booth: Booth
    @State private var footer = ""
    @State private var count = 3
    @State private var server = ""
    @State private var pending = (0, 0)
    @State private var tick = 0
    var body: some View {
        let s = booth.settings
        NavigationStack {
            Form {
                Section("Party") {
                    if let p = booth.party {
                        Text("Shooting for “\(p.name)”\(p.qr ? " · QR on strips" : "")\(p.footer.map { $0.isEmpty ? "" : " · footer: \($0)" } ?? "")")
                    } else { Text("No party — photos go to the archive only.").foregroundStyle(.secondary) }
                    Link("🎉 Parties, signs & albums", destination: s.server.appendingPathComponent("party.html"))
                    Link("🗂️ Archive", destination: s.server.appendingPathComponent("gallery.html"))
                    Text("Archive queue: \(pending.0) session\(pending.0 == 1 ? "" : "s") waiting (\(pending.1 / 1024) KB)").foregroundStyle(.secondary)
                }
                Section("Strip") {
                    TextField("Footer text (optional)", text: $footer).onChange(of: footer) { s.footer = String(footer.prefix(40)) }
                    Stepper("Countdown: \(count) s", value: $count, in: 1...10).onChange(of: count) { s.count = count }
                }
                Section {
                    chips(CALIBRATION_GAINS.enumerated().map { ("\(Character(UnicodeScalar(65 + $0.offset)!)) · \($0.element)", $0.element) }, s.gain) { s.gain = $0 }
                    Button("🧪 Print calibration strip") { Task { await booth.printCalibration() } }
                } header: { Text("Anti-ghosting") } footer: { Text("Print the calibration strip, then pick the band whose greys under the black block match the greys to its right.") }
                Section("Print density") { chips([("−2", 5), ("−1", 4), ("std", 3), ("+1", 2), ("+2", 1)], s.density) { s.density = $0 } }
                Section { chips([("fast", 0), ("mid", 1), ("slow", 2)], s.speed) { s.speed = $0 } } header: { Text("Print speed") } footer: { Text("Slower = cooler head = less ghosting.") }
                Section("Sounds") { chips([("on", true), ("off", false)], s.sound) { s.sound = $0 } }
                Section { chips([("on", true), ("off", false)], s.livePreview) { s.livePreview = $0 } } header: { Text("Live print preview") } footer: {
                    Text("The camera shows the photo in printer dots, cropped as it prints. If this device can't keep up it shows the plain camera until settings are closed again.")
                }
                Section("Server") {
                    TextField("https://booth.receiptd.sh", text: $server).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Use this server") { if let u = URL(string: server), u.scheme == "https" { booth.pair(server: u, pin: nil) } }
                }
                if let links = booth.shareLinks { shareSection(links) }
                if let st = booth.status { Section { Text(st) } }
                Section {
                    if s.bundledPin.isEmpty {
                        Button("🔒 Lock booth", role: .destructive) { booth.forgetSavedPin() }
                    } else if !s.pin.isEmpty {
                        Button("Forget saved PIN", role: .destructive) { booth.forgetSavedPin(); tick += 1 }
                    }
                } footer: {
                    if !s.bundledPin.isEmpty { Text(s.pin.isEmpty ? "Using the PIN built into this app." : "A saved PIN is in use; forgetting it goes back to the PIN built into this app.") }
                }
            }
            .id(tick)
            .navigationTitle("Booth settings")
            .toolbar { Button("Done") { booth.closeSettings() }.bold() }
        }
        .onAppear {
            footer = s.footer; count = s.count; server = s.server.absoluteString
            Task { pending = await booth.archive.pending() }
        }
    }

    /// Peer-to-peer setup: links that carry the booth PIN, as share sheets and as QR codes.
    func shareSection(_ links: (web: URL, app: URL)) -> some View {
        Section {
            ShareLink(item: links.web, subject: Text("Photo booth"), message: Text("Open the photo booth (already unlocked)")) {
                Label("Booth on the web", systemImage: "safari")
            }
            ShareLink(item: links.app, subject: Text("Photo Booth app"), message: Text("Get the Photo Booth app (TestFlight). After it's installed, tap this link again to set it up.")) {
                Label("Booth app (TestFlight)", systemImage: "apps.iphone")
            }
            NavigationLink { ShareBoothView(web: links.web, app: links.app) } label: { Label("Show as QR codes", systemImage: "qrcode") }
        } header: { Text("Share booth") } footer: {
            Text("Booth on the web opens this booth in Safari, already unlocked. Booth app signs the phone up for the TestFlight app; once it's installed, the same link opens the app set up for this booth. Both links contain the booth PIN, so only send them to people you'd hand the iPad to.")
        }
    }

    func chips<T: Equatable>(_ opts: [(String, T)], _ cur: T, set: @escaping (T) -> Void) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                ForEach(Array(opts.enumerated()), id: \.offset) { _, o in
                    Button(o.0) { set(o.1); tick += 1 }
                        .buttonStyle(.borderedProminent).tint(o.1 == cur ? Color.ink : Color.ink.opacity(0.15))
                        .foregroundStyle(o.1 == cur ? Color.white : Color.ink)
                }
            }
        }
    }
}

/// Share booth: each link as a big QR code (black on white, for a phone next to the iPad to scan)
/// and a share sheet button (AirDrop, Messages, …). Settings → Share booth → QR codes, and the
/// camera screen's 📤 sticker (in a sheet). Adult surface: words allowed.
struct ShareBoothView: View {
    let web: URL, app: URL
    var body: some View {
        ScrollView {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 40) { codes }
                VStack(spacing: 40) { codes }
            }
            .padding(24).frame(maxWidth: .infinity)
            Text("Both links contain the booth PIN: only share them with people you'd hand the booth to.")
                .font(.footnote).foregroundStyle(.black.opacity(0.6)).multilineTextAlignment(.center).padding(.horizontal, 24).padding(.bottom, 24)
        }
        .background(Color.white)
        .environment(\.colorScheme, .light)
        .navigationTitle("Share booth")
        .navigationBarTitleDisplayMode(.inline)
    }
    @ViewBuilder var codes: some View {
        code(web, icon: "🌐", title: "Booth on the web", hint: "Opens this booth in the phone's browser, already unlocked.",
             message: "Open the photo booth (already unlocked)")
        code(app, icon: "📱", title: "Booth app (TestFlight)", hint: "Signs an iPhone or iPad up for the app. Once it's installed, the same link opens the app set up for this booth.",
             message: "Get the Photo Booth app (TestFlight). After it's installed, tap this link again to set it up.")
    }
    func code(_ url: URL, icon: String, title: String, hint: String, message: String) -> some View {
        VStack(spacing: 12) {
            QRCodeView(text: url.absoluteString).aspectRatio(1, contentMode: .fit).frame(maxWidth: 340)
                .accessibilityElement().accessibilityAddTraits(.isImage).accessibilityLabel("QR code: \(title)")
            Text("\(icon) \(title)").font(.title2.bold()).foregroundStyle(.black)
            Text(hint).font(.callout).foregroundStyle(.black.opacity(0.7)).multilineTextAlignment(.center).frame(maxWidth: 340)
            ShareLink(item: url, subject: Text(title), message: Text(message)) { Label("Send link", systemImage: "square.and.arrow.up") }
                .buttonStyle(.borderedProminent).tint(Color.ink).accessibilityLabel("Send link: \(title)")
        }
    }
}

/// The camera screen's 📤 sticker: a small grown-up button (kids' targets are the big ones).
struct ShareButton: View {
    @EnvironmentObject var booth: Booth
    @State private var open = false
    var body: some View {
        if let links = booth.shareLinks {
            Button { Sfx.shared.play("tap"); open = true } label: { Emoji("📤", size: 22).frame(width: 46, height: 46) }
                .buttonStyle(StickerStyle(fill: .white, corner: 14, line: 3, shadow: 3, tilt: -4))
                .accessibilityLabel("Share booth")
                .sheet(isPresented: $open) {
                    NavigationStack {
                        ShareBoothView(web: links.web, app: links.app)
                            .toolbar { Button("Done") { open = false }.bold() }
                    }
                    .presentationSizing(.page)
                }
        }
    }
}

/// A QR code from BoothCore's encoder (the web app's exact modules), with a 4-module quiet zone.
struct QRCodeView: View {
    let text: String
    var body: some View {
        let m = QR.matrix(text)
        SwiftUI.Canvas { ctx, size in
            let quiet = 4, side = m.n + 2 * quiet
            let k = floor(min(size.width, size.height) / CGFloat(side))   // whole points per module: crisp edges
            let o = CGPoint(x: (size.width - k * CGFloat(side)) / 2, y: (size.height - k * CGFloat(side)) / 2)
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
            var p = Path()
            for r in 0..<m.n { for c in 0..<m.n where m.dark(r, c) {
                p.addRect(CGRect(x: o.x + CGFloat(c + quiet) * k, y: o.y + CGFloat(r + quiet) * k, width: k, height: k))
            } }
            ctx.fill(p, with: .color(.black))
        }
    }
}
