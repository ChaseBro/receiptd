// Kid screens: drawn icons (or Classic emoji), shapes and numerals only (words are accessibility
// labels). Adult settings: press and hold the small gear at the camera's top-right for 1.2 s.
// Adult labels (AdultHint) appear only in answer to a tap/hold on the gear, share-the-booth
// or the printer badge, one at a time, and fade after ~2.5 s.

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
            if let m = booth.mine { MineOverlay(share: m) }
        }
        // First-run coach: the hand + spotlight over whichever control it points at (no hit testing).
        .overlayPreferenceValue(CoachTargets.self) { targets in
            GeometryReader { g in
                if let step = booth.coachStep, let a = targets[step] { CoachOverlay(step: step, target: g[a], size: g.size).environmentObject(booth) }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
        .environmentObject(booth)
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .onOpenURL { url in if let p = Pairing(url: url) { booth.pair(server: p.server, pin: p.key) } }
        // Not on settings: a root tap gesture swallows Form row taps (buttons, links, ShareLink).
        .simultaneousGesture(TapGesture().onEnded { booth.touched(); booth.coachTapped() }, including: booth.screen == .settings ? .subviews : .all)
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
                // Any PIN: digits, a word or a phrase. Normal keyboard, no autocorrect / auto-caps
                // (the server compares exactly, case included); the ends are trimmed.
                SecureField("", text: $pin)
                    .keyboardType(.default).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.go).focused($focused)
                    .font(Fonts.display(32)).multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
                    .frame(width: 300, height: 72)
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
    func go() { let p = pin.trimmingCharacters(in: .whitespacesAndNewlines); pin = ""; Task { await booth.unlock(p) } }
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
                // The stage is the photo slot's shape (4:3 / 4:5, frames.js slotAspect), as big as fits,
                // centred: the live dots and the plain camera fill it edge to edge, exactly the crop that prints.
                SlotShaped(camera: booth.camera) {
                    ZStack {
                        stage(accent: a)
                        RingView().allowsHitTesting(false)
                    }
                }
                if landscape { tray(accent: b, landscape: true).frame(maxHeight: .infinity) } else { tray(accent: b, landscape: false) }
            }
            .padding(20)
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .overlay { if booth.flash { Color.white.ignoresSafeArea() } }
        .onAppear { booth.applyTheme() }
    }

    /// The theme picker (scrolls) and, at its end, the grown-up "share the booth" sticker: off the
    /// camera window, beside the themes (portrait: top bar, right end; landscape: column, bottom).
    func themePicker(landscape: Bool) -> some View {
        let gear: CGFloat = UIDevice.current.userInterfaceIdiom == .pad ? 60 : 44
        let bar = landscape ? AnyLayout(VStackLayout(spacing: 10)) : AnyLayout(HStackLayout(spacing: 10))
        return bar {
            themeScroller(landscape: landscape)
            if booth.shareLinks != nil {
                ShareBoothButton(size: gear, pillSide: landscape ? .trailing : .leading)
                    .padding(landscape ? .bottom : .trailing, 10)
                    .padding(landscape ? .trailing : .bottom, 6)
            }
        }
        .frame(maxWidth: landscape ? 110 : .infinity, maxHeight: landscape ? .infinity : 110)
    }

    func themeScroller(landscape: Bool) -> some View {
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
        .accessibilityIdentifier("themes")
    }

    func stage(accent: Color) -> some View {
        ZStack(alignment: .top) {
            Color.black.overlay(CameraPreview(camera: booth.camera))   // size from layout, not the view's intrinsic size
                .overlay(LiveDots(camera: booth.camera))                  // live print preview (when on)
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(Color.ink, lineWidth: LINE_FAT))
                .background(RoundedRectangle(cornerRadius: 28).fill(Color.ink).offset(x: 8, y: 8))
            if booth.shots > 1 {
                HStack(spacing: 10) {
                    ForEach(0..<booth.shots, id: \.self) { i in
                        Circle().fill(i < booth.dotsDone ? accent : .white).frame(width: 22, height: 22).overlay(Circle().stroke(Color.ink, lineWidth: 3))
                    }
                }.padding(.top, 14)
            }
            if booth.camera.failed {
                VStack(spacing: 18) {
                    Sticker(fill: .white, corner: 999) { IconView(name: "nocam").frame(width: 90, height: 90).padding(16) }
                    Button { booth.startCamera() } label: { IconView(name: "again").frame(width: 66, height: 66).frame(width: 90, height: 90) }
                        .buttonStyle(StickerStyle(fill: .sun, corner: 999)).accessibilityLabel("Try again")
                }.frame(maxHeight: .infinity)
            }
            // Grown-up stickers on the camera window: the settings gear top-right (press-and-hold); the
            // printer badge bottom-left, only when the printer needs a grown-up. (Share the booth sits
            // beside the theme picker, off the camera window.)
            let gear: CGFloat = UIDevice.current.userInterfaceIdiom == .pad ? 60 : 44
            HStack(alignment: .top) {
                Spacer()
                HoldButton(id: "gear", a11y: "Settings", hint: "Hold to open settings", size: gear, tilt: 6, pillSide: .leading) { booth.openSettings() } label: {
                    IconView(name: "gear")
                }
            }
            .padding(.horizontal, 20).padding(.top, 20)
            if let h = booth.printer, let st = booth.printerState, st.needsAdult || st.soft {
                PrinterBadge(health: h, id: "printer", size: gear < 50 ? 76 : 96)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading).padding(18)
            }
        }
    }

    func tray(accent: Color, landscape: Bool) -> some View {
        let l = landscape ? AnyLayout(VStackLayout(spacing: 26)) : AnyLayout(HStackLayout(spacing: 26))
        return l {
            Button { booth.toggleShots() } label: { IconView(name: booth.shots == 1 ? "one" : "three").frame(width: 60, height: 60).frame(width: 80, height: 80) }
                .buttonStyle(StickerStyle(fill: .white, corner: 20, tilt: -6)).accessibilityLabel(booth.shots == 1 ? "One photo" : "Three photos")
            Button { Task { await booth.shutter() } } label: { IconView(name: "shutter").frame(width: 112, height: 112).frame(width: 150, height: 150) }
                .buttonStyle(StickerStyle(fill: accent, corner: 999, line: LINE_FAT, shadow: 8))
                .disabled(booth.busy || booth.shutterLocked)
                .scaleEffect(bounce ? 1.06 : 0.96)
                .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever()) { bounce = true } }
                .accessibilityLabel("Take photo").coachTarget("shutter")
            Button { Sfx.shared.play("boop"); booth.camera.flip() } label: { IconView(name: "flip").frame(width: 60, height: 60).frame(width: 80, height: 80) }
                .buttonStyle(StickerStyle(fill: .white, corner: 20, tilt: 6)).accessibilityLabel("Switch camera")
        }
    }
}

/// A grown-up corner sticker: press and hold `seconds` (1.2) → action. While held, a grape ring
/// fills and "Keep holding…" shows beside it; a haptic tick at 50 %, a pop at full. Let go early:
/// the ring drains and nothing happens; a short tap shows `hint` (~2.5 s) and wiggles the sticker.
/// VoiceOver activation opens straight away (an adult using assistive tech, not a kid mashing).
struct HoldButton<Label: View>: View {
    @EnvironmentObject var booth: Booth
    let id: String
    let a11y: String
    let hint: String
    var size: CGFloat = 44
    var tilt: Double = 0
    var pillSide: HorizontalEdge = .leading
    var seconds: Double = 1.2
    let action: () -> Void
    @ViewBuilder var label: Label
    @State private var progress: CGFloat = 0
    @State private var t0: Date?
    @State private var task: Task<Void, Never>?
    @State private var wiggle = 0

    var body: some View {
        Sticker(fill: .white, corner: size * 0.3, line: 3, shadow: 3, tilt: tilt, pressed: t0 != nil) {
            label.frame(width: size * 0.8, height: size * 0.8).frame(width: size, height: size)
        }
        .overlay {
            ZStack {
                Circle().stroke(Color.ink.opacity(0.18), lineWidth: 8)
                Circle().trim(from: 0, to: progress).stroke(Color.ink, style: StrokeStyle(lineWidth: 9, lineCap: .round))
                Circle().trim(from: 0, to: progress).stroke(Color.grape, style: StrokeStyle(lineWidth: 5, lineCap: .round))
            }
            .rotationEffect(.degrees(-90))
            .frame(width: size + 22, height: size + 22)
            .opacity(t0 != nil || progress > 0 ? 1 : 0)
            .allowsHitTesting(false)
        }
        .keyframeAnimator(initialValue: 0.0, trigger: wiggle) { v, a in v.rotationEffect(.degrees(a)) } keyframes: { _ in
            KeyframeTrack { CubicKeyframe(-16, duration: 0.1); CubicKeyframe(13, duration: 0.12); CubicKeyframe(-6, duration: 0.12); CubicKeyframe(0, duration: 0.14) }
        }
        .contentShape(Rectangle())
        .gesture(DragGesture(minimumDistance: 0).onChanged { _ in if t0 == nil, task == nil { begin() } }.onEnded { _ in end() })
        .accessibilityElement()
        .accessibilityLabel(a11y)
        .accessibilityHint("Press and hold")
        .accessibilityAddTraits(.isButton)
        .accessibilityIdentifier(id)
        .accessibilityAction { action() }
        .adultHint(id, side: pillSide)   // outside the button's accessibility element, so it's its own static text
    }

    private func begin() {
        let start = Date(); t0 = start
        booth.touched()
        booth.showHint(id, "Keep holding…", seconds: nil)
        let tick = UIImpactFeedbackGenerator(style: .light), pop = UINotificationFeedbackGenerator()
        tick.prepare(); pop.prepare()
        task = Task { @MainActor in
            var ticked = false
            while !Task.isCancelled {
                let p = min(1, Date().timeIntervalSince(start) / seconds)
                progress = p
                if p >= 0.5 && !ticked { ticked = true; tick.impactOccurred() }
                if p >= 1 {
                    pop.notificationOccurred(.success); Sfx.shared.play("tap")
                    t0 = nil; task = nil; progress = 0
                    booth.hideHint(id)
                    action()
                    return
                }
                try? await Task.sleep(for: .milliseconds(16))
            }
        }
    }

    private func end() {
        guard let start = t0 else { task = nil; return }
        task?.cancel(); task = nil; t0 = nil
        withAnimation(.easeOut(duration: 0.25)) { progress = 0 }   // drain
        if Date().timeIntervalSince(start) < 0.45 {
            booth.showHint(id, hint); wiggle += 1; Sfx.shared.play("boop")
        } else { booth.hideHint(id) }
    }
}

/// The one adult label, as a small quiet pill beside its control (`side`: which side of the
/// control it sits on). Shown only while `booth.hint` belongs to this control.
struct HintOverlay: ViewModifier {
    @EnvironmentObject var booth: Booth
    let id: String
    let side: HorizontalEdge
    func body(content: Content) -> some View {
        let maxW: CGFloat = UIDevice.current.userInterfaceIdiom == .pad ? 380 : 230
        content.overlay(alignment: side == .leading ? .leading : .trailing) {
            if let h = booth.hint, h.anchor == id {
                Text(h.text)
                    .font(.system(size: 15, weight: .bold, design: .rounded)).foregroundStyle(Color.ink)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(RoundedRectangle(cornerRadius: 14).fill(.white))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.ink, lineWidth: 3))
                    .background(RoundedRectangle(cornerRadius: 14).fill(Color.ink).offset(x: 3, y: 3))
                    .accessibilityIdentifier("adultHint")
                    .frame(width: maxW, alignment: side == .leading ? .trailing : .leading)
                    .offset(x: side == .leading ? -(maxW + 14) : maxW + 14)   // beside the control, not over it
                    .allowsHitTesting(false)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.18), value: booth.hint)
    }
}
extension View {
    func adultHint(_ id: String, side: HorizontalEdge) -> some View { modifier(HintOverlay(id: id, side: side)) }
}

/// What the printer needs, drawn (one drawing per problem) on a sun sticker with a slow wiggle.
/// A tap shows the adult label ("Printer offline · last seen 2:14 pm · Check its power & Wi-Fi").
/// A napping printer (stale check-in, being woken) gets the quiet version: smaller, still, see-through.
struct PrinterBadge: View {
    @EnvironmentObject var booth: Booth
    let health: PrinterHealth
    let id: String
    var size: CGFloat = 84
    var body: some View {
        let state = health.state(wake: booth.wake), soft = state.soft
        Button { booth.showHint(id, health.hint(wake: booth.wake)) } label: { IconView(name: state.icon).frame(width: size * 0.84, height: size * 0.84).frame(width: size, height: size) }
            .buttonStyle(StickerStyle(fill: .sun, corner: size * 0.28, line: LINE_FAT, shadow: 8, tilt: -8))
            .keyframeAnimator(initialValue: 0.0, repeating: true) { v, a in v.rotationEffect(.degrees(soft ? 0 : a)) } keyframes: { _ in
                KeyframeTrack { LinearKeyframe(0, duration: 3.4); CubicKeyframe(-9, duration: 0.12); CubicKeyframe(8, duration: 0.16); CubicKeyframe(-4, duration: 0.16); CubicKeyframe(0, duration: 0.12) }
            }
            .scaleEffect(soft ? 0.78 : 1, anchor: .bottomLeading)
            .opacity(soft ? 0.72 : 1)
            .accessibilityLabel(state.label)
            .accessibilityIdentifier("printerBadge")
            .accessibilityValue(state.rawValue)
            .adultHint(id, side: .trailing)
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
                            // Each photo's place on the strip (for the orientation UI tests: "up is up" in review).
                            ForEach(Array(p.layout.photos.enumerated()), id: \.offset) { i, ph in
                                Rectangle().fill(Color.clear).frame(width: ph.w * k, height: ph.h * k)
                                    .accessibilityElement().accessibilityLabel("Photo \(i + 1)").accessibilityAddTraits(.isImage)
                                    .accessibilityIdentifier("reviewPhoto\(i + 1)")
                                    .position(x: (ph.x + ph.w / 2) * k, y: (ph.y + ph.h / 2) * k)
                                    .allowsHitTesting(false)
                            }
                            ForEach(Array(p.layout.photos.enumerated()), id: \.offset) { i, ph in
                                Button { Task { await booth.rotatePhoto(i) } } label: { IconView(name: "rotate").frame(width: 48, height: 48).frame(width: 64, height: 64) }
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
                    Button { booth.bumpCopies(-1) } label: { IconView(name: "minus").frame(width: 52, height: 52).frame(width: 72, height: 72) }
                        .buttonStyle(StickerStyle(fill: .white, corner: 999)).opacity(booth.copies <= 1 ? 0.4 : 1).accessibilityLabel("Fewer copies")
                    Sticker(fill: .sun, corner: 20) {
                        HStack(spacing: 4) { IconView(name: "receipt").frame(width: 50, height: 50); Text("×\(booth.copies)").font(Fonts.display(40)).foregroundStyle(Color.ink) }
                            .padding(.horizontal, 16).frame(height: 80)
                    }
                    .accessibilityElement().accessibilityLabel("\(booth.copies) \(booth.copies == 1 ? "copy" : "copies")")
                    Button { booth.bumpCopies(1) } label: { IconView(name: "plus").frame(width: 52, height: 52).frame(width: 72, height: 72) }
                        .buttonStyle(StickerStyle(fill: booth.iconStyle == .drawn ? .grape : .white, corner: 999))
                        .opacity(booth.copies >= booth.settings.copiesMax ? 0.4 : 1).accessibilityLabel("More copies")
                }
            }
            HStack(spacing: 30) {
                Button { booth.retake() } label: { IconView(name: "retake").frame(width: 86, height: 86).frame(width: 120, height: 120) }
                    .buttonStyle(StickerStyle(fill: .tomato, corner: 999, line: LINE_FAT)).accessibilityLabel("Retake")
                Button { Task { await booth.printStrip() } } label: { IconView(name: "print").frame(width: 110, height: 110).frame(width: 150, height: 150) }
                    .buttonStyle(StickerStyle(fill: .mint, corner: 999, line: LINE_FAT, shadow: 8)).accessibilityLabel("Print").coachTarget("print")
                    .disabled(booth.preview == nil)
                ShareThisPhotoButton(size: 96)
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
                    HStack(spacing: 14) { if st.error { Emoji("😕", size: 64) } else { IconView(name: "pPrinting").frame(width: 84, height: 84) }; Circle().fill(st.error ? Color.tomato : .mint).frame(width: 22, height: 22).overlay(Circle().stroke(Color.ink, lineWidth: 3)) }
                        .frame(width: 280, height: 130)
                }
            }
            .frame(height: 500, alignment: .top)
            .onAppear { feed = 0; withAnimation(.easeOut(duration: 3)) { feed = 1 } }
            .onChange(of: st.go) { feed = 0.2; withAnimation(.easeOut(duration: 2.5)) { feed = 1 } }

            if st.copies > 1 {
                HStack(spacing: 12) {
                    ForEach(0..<st.copies, id: \.self) { i in
                        Sticker(fill: i < st.done ? .mint : .white, corner: 16) { IconView(name: "receipt").frame(width: 40, height: 40).padding(6) }
                            .offset(y: i == st.done ? -8 : 0)
                            .animation(.easeInOut(duration: 0.5).repeatForever(), value: st.done)
                    }
                }.accessibilityHidden(true)
            }
            if st.position > 1 {
                // In line: Drawn = one hourglass with the number of jobs ahead; Classic = ⏳ + a 🧾 per job.
                if booth.iconStyle == .drawn {
                    Sticker(fill: .white, corner: 999) { IconView(name: "queue", arg: st.position - 1).frame(width: 60, height: 60).padding(8) }
                        .accessibilityElement().accessibilityLabel("\(st.position - 1) ahead in line")
                } else {
                    HStack(spacing: 8) { Emoji("⏳", size: 30); ForEach(0..<min(4, st.position - 1), id: \.self) { _ in Emoji("🧾", size: 26) } }
                }
            }
            if let h = booth.printer, booth.printerState?.needsAdult == true { PrinterBadge(health: h, id: "printerWait", size: 110) }
            if !st.error { ShareThisPhotoButton(size: 88) }
            if st.error {
                HStack(spacing: 30) {
                    Button { booth.printBack() } label: { IconView(name: "back").frame(width: 72, height: 72).frame(width: 100, height: 100) }.buttonStyle(StickerStyle(fill: .tomato, corner: 999)).accessibilityLabel("Back")
                    Button { Task { await booth.printRetry() } } label: { IconView(name: "again").frame(width: 72, height: 72).frame(width: 100, height: 100) }.buttonStyle(StickerStyle(fill: .sun, corner: 999)).accessibilityLabel("Try again")
                }
            }
        }
    }
}

struct DoneOverlay: View {
    let face: String
    @EnvironmentObject var booth: Booth
    @State private var pop = false
    var body: some View {
        ZStack {
            Confetti()
            Sticker(fill: .sun, corner: 999, line: LINE_FAT, shadow: 10, tilt: -8) {
                if booth.iconStyle == .drawn { DrawnIcon(name: "done").frame(width: 150, height: 150).padding(30) } else { Emoji(face, size: 120).padding(40) }
            }
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
    @State private var server = ""
    @State private var pending = (0, 0)
    @State private var retrying = false
    @State private var uploadFailure: String?
    @State private var tick = 0
    var body: some View {
        let s = booth.settings
        NavigationStack {
            Form {
                // Status first (is anything wrong?), then the fixes. Red tint = needs attention.
                Section {
                    statusTiles
                    HStack(spacing: 10) {
                        Button("Nudge printer") { Task { await booth.nudgePrinter() } }.buttonStyle(.borderedProminent).tint(.sun).foregroundStyle(Color.ink)
                        Button("Upload now") { Task { await booth.uploadNow(); await refreshQueue() } }.buttonStyle(.bordered).tint(Color.ink)
                        Button("Print test strip") { Task { await booth.printCalibration() } }.buttonStyle(.bordered).tint(Color.ink)
                    }
                    .font(.callout.bold()).buttonBorderShape(.capsule)
                    if let st = booth.status { Text(st).accessibilityIdentifier("settingsStatus") }
                }
                .listRowSeparator(.hidden)

                Section {
                    LabeledContent("Icon style") {
                        Picker("Icon style", selection: bind({ booth.iconStyle }, { booth.setIconStyle($0) })) {
                            Text("Drawn").tag(IconStyle.drawn); Text("Classic 📸").tag(IconStyle.classic)
                        }.pickerStyle(.segmented).labelsHidden().fixedSize().accessibilityIdentifier("iconStyle")
                    }
                    Toggle(isOn: bind({ s.livePreview }, { s.livePreview = $0 })) { sub("Live print preview", "Camera shows the 1-bit print look (plain camera until settings close if the device can't keep up)") }
                    Toggle("Sounds", isOn: bind({ s.sound }, { s.sound = $0 }))
                    Toggle(isOn: bind({ s.flash }, { s.flash = $0 })) { sub("Screen flash", "White flash on capture") }
                    Button { booth.showCoachAgain(); tick += 1 } label: { sub("Show the how-to again", "A pointing hand shows the next kid: tap the camera, then print (until a print goes out)") }
                        .accessibilityIdentifier("showCoachAgain")
                } header: { head("shutter", "Booth") }

                Section {
                    LabeledContent("Start with") {
                        Picker("Start with", selection: bind({ s.startFront }, { s.startFront = $0; booth.camera.facing = $0 ? .front : .back })) {
                            Text("Front").tag(true); Text("Back").tag(false)
                        }.pickerStyle(.segmented).labelsHidden().fixedSize()
                    }
                    Toggle(isOn: bind({ s.mirror }, { s.mirror = $0 })) { sub("Mirror preview", "Selfie camera only; prints are never mirrored") }
                    Stepper("Countdown: \(s.count) s", value: bind({ s.count }, { s.count = $0 }), in: 1...10)
                    LabeledContent { 
                        Picker("Photos per strip", selection: bind({ booth.shots }, { booth.shots = $0; s.shots = $0 })) { Text("1").tag(1); Text("3").tag(3) }
                            .pickerStyle(.segmented).labelsHidden().fixedSize()
                    } label: { sub("Photos per strip", "Kids can switch") }
                } header: { head("flip", "Camera") }

                Section {
                    Stepper(value: bind({ s.copiesStart }, { s.copiesStart = $0 }), in: 1...s.copiesMax) { sub("Copies to start with: \(s.copiesStart)", "One per face, but at least this") }
                    Stepper(value: bind({ s.copiesMax }, { s.copiesMax = $0; if s.copiesStart > $0 { s.copiesStart = $0 } }), in: 1...MAX_COPIES) {
                        sub("Most copies a kid can pick: \(s.copiesMax)", "The printer takes \(MAX_COPIES) at most")
                    }
                    TextField("Footer text (optional)", text: $footer).onChange(of: footer) { s.footer = String(footer.prefix(40)) }
                } header: { head("receipt", "Strip & copies") }

                Section {
                    if let p = booth.party {
                        sub("Party: \(p.name)", "Photos also go to its album\(p.footer.map { $0.isEmpty ? "" : " · footer: \($0)" } ?? "")")
                        sub("QR on strips: \(p.qr ? "on" : "off")", "Follows the party (set it on the party page)")
                    } else { sub("No party", "Photos go to the archive only") }
                    Link("Parties, signs & albums", destination: s.server.appendingPathComponent("party.html"))
                    if let links = booth.shareLinks {
                        NavigationLink { ShareBoothView(web: links.web, app: links.app, pin: booth.api.pin) } label: { Label("Share the booth: PIN and QR codes", systemImage: "qrcode") }
                        ShareLink(item: links.web, subject: Text("Photo booth"), message: Text("Open the photo booth (already unlocked)")) { Label("Booth on the web", systemImage: "safari") }
                        ShareLink(item: links.app, subject: Text("Photo Booth app"), message: Text("Get the Photo Booth app (TestFlight). After it's installed, tap this link again to set it up.")) {
                            Label("Booth app (TestFlight)", systemImage: "apps.iphone")
                        }
                    }
                } header: { head("party", "Party & sharing") } footer: {
                    if booth.shareLinks != nil {
                        Text("Share the booth lets guests use their own phone as a booth too: it prints to the same printer and their photos join the party album. It lets them use your booth (prints, photos): both links contain the booth PIN. Also on the camera screen: hold the phone-with-plus beside the themes.")
                    }
                }

                Section {
                    HStack {
                        sub("Status", printerLine)
                        Spacer()
                        Button("Nudge") { Task { await booth.nudgePrinter() } }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(Color.ink)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        sub("Anti-ghosting", "Print the calibration strip, then pick the band whose greys under the black block match the greys to its right")
                        chips(CALIBRATION_GAINS.enumerated().map { ("\(Character(UnicodeScalar(65 + $0.offset)!))", $0.element) }, s.gain) { s.gain = $0 }
                    }
                    VStack(alignment: .leading, spacing: 6) { Text("Darkness"); chips([("−2", 5), ("−1", 4), ("std", 3), ("+1", 2), ("+2", 1)], s.density) { s.density = $0 } }
                    VStack(alignment: .leading, spacing: 6) { sub("Speed", "Slower = cooler head = less ghosting"); chips([("fast", 0), ("mid", 1), ("slow", 2)], s.speed) { s.speed = $0 } }
                    Button("Print calibration strip") { Task { await booth.printCalibration() } }
                } header: { head("pReady", "Printer") }

                Section {
                    HStack {
                        sub("Upload queue", pending.0 == 0 ? "Nothing waiting" : "\(pending.0) session\(pending.0 == 1 ? "" : "s") · \(pending.1 / 1024) KB\(retrying ? " · retrying" : "")\(uploadFailure.map { " · failing (\($0))" } ?? "")")
                        Spacer()
                        Button("Upload now") { Task { await booth.uploadNow(); await refreshQueue() } }.buttonStyle(.bordered).buttonBorderShape(.capsule).tint(Color.ink)
                    }
                    Link("Archive (every session, by day)", destination: s.server.appendingPathComponent("gallery.html"))
                    TextField("https://booth.receiptd.sh", text: $server).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Use this server") { if let u = URL(string: server), u.scheme == "https" { booth.pair(server: u, pin: nil) } }
                } header: { head("upload", "Archive & server") }

                Section {
                    CameraDiagnostics(camera: booth.camera)
                } header: { head("gear", "About this booth") } footer: {
                    Text("For troubleshooting: which way the camera thinks is up. Also logged once per camera start (Console, subsystem com.chasebro.booth).")
                }

                Section {
                    if s.bundledPin.isEmpty {
                        Button("Lock booth now", role: .destructive) { booth.forgetSavedPin() }
                    } else if !s.pin.isEmpty {
                        Button("Forget saved PIN", role: .destructive) { booth.forgetSavedPin(); tick += 1 }
                    } else { Text("Using the PIN built into this app.").foregroundStyle(.secondary) }
                } header: { head("gear", "Lock") } footer: {
                    if !s.bundledPin.isEmpty && !s.pin.isEmpty { Text("A saved PIN is in use; forgetting it goes back to the PIN built into this app.") }
                }
            }
            .id(tick)
            .navigationTitle("Booth settings")
            .toolbar { Button("Done") { booth.closeSettings() }.bold() }
        }
        .onAppear {
            footer = s.footer; server = s.server.absoluteString
            Task { await refreshQueue() }
        }
    }

    func refreshQueue() async { pending = await booth.archive.pending(); retrying = await booth.archive.retrying(); uploadFailure = await booth.archive.lastFailure }

    /// A setting binding that also redraws the form.
    func bind<T>(_ get: @escaping () -> T, _ set: @escaping (T) -> Void) -> Binding<T> {
        Binding(get: get, set: { set($0); tick += 1 })
    }
    func head(_ icon: String, _ title: String) -> some View {
        HStack(spacing: 8) { IconView(name: icon).frame(width: 24, height: 24); Text(title) }
    }
    func sub(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) { Text(title); Text(detail).font(.caption).foregroundStyle(.secondary) }
    }

    var printerLine: String {
        guard let h = booth.printer else { return "Checking…" }
        let st = h.state(wake: booth.wake)
        if st == .offline || st == .asleep { return h.hint(wake: booth.wake) }
        let paper = h.paperOut ? "out of paper" : h.coverOpen ? "cover open" : h.paperLow == true ? "paper low" : "paper OK"
        return "\(st == .error ? "Error" : "Ready") · \(paper)\(h.text.map { $0.isEmpty ? "" : " · \($0)" } ?? "")"
    }

    /// Printer · paper · uploads, drawn, with words. Red tint when it needs attention.
    var statusTiles: some View {
        let h = booth.printer, state = booth.printerState, stale = h != nil && h?.online != true
        let printer: (String, String, String, Bool) = state == nil ? ("pReady", "Printer", "checking…", false)
            : state == .offline ? ("pOffline", "Printer offline", h?.lastSeenSec.map { "since \(PrinterHealth.clock(Date().addingTimeInterval(-Double($0))))" } ?? "never seen", true)
            : state == .asleep ? ("pAsleep", "Printer napping", booth.wake.phase == .waking ? "waking it up…" : "last check-in \(PrinterHealth.ago(h?.lastSeenSec))", false)
            : state == .error ? ("pError", "Printer error", "turn it off and on", true) : ("pReady", "Printer ready", "online", false)
        let paper: (String, String, String, Bool) = h == nil ? ("paperOk", "Paper", "—", false)
            : h!.paperOut ? ("pPaperOut", "Out of paper", "load a roll", true)
            : h!.coverOpen ? ("pCover", "Cover open", "close the lid", true)
            : state == .offline ? ("paperOk", "Paper", "unknown while offline", false)
            : h!.paperLow == true ? ("pPaperLow", "Paper low", "cover closed", false)
            : stale ? ("paperOk", "Paper OK", "as of its last check-in", false) : ("paperOk", "Paper OK", "cover closed", false)
        let up: (String, String, String, Bool) = pending.0 == 0 ? ("upload", "All uploaded", "archive", false)
            : uploadFailure.map { ("upload", "Uploads failing", "\(pending.0) waiting · \($0)", true) }
            ?? ("upload", "\(pending.0) waiting", retrying ? "retrying" : "to upload", retrying)
        return HStack(spacing: 10) { tile(printer); tile(paper); tile(up) }
            .accessibilityElement(children: .contain).accessibilityIdentifier("statusTiles")
    }
    func tile(_ t: (String, String, String, Bool)) -> some View {
        VStack(spacing: 3) {
            IconView(name: t.0).frame(width: 46, height: 46)
            Text(t.1).font(.footnote.bold()).multilineTextAlignment(.center)
            Text(t.2).font(.caption2).foregroundStyle(.secondary)
        }
        .foregroundStyle(Color.ink)
        .frame(maxWidth: .infinity).padding(.vertical, 8).padding(.horizontal, 4)
        .background(RoundedRectangle(cornerRadius: 14).fill(t.3 ? Color(hex: 0xFFDED7) : Color.white))   // tomato 22 % on white (index.html .tile.bad)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.ink, lineWidth: 3))
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.ink).offset(x: 3, y: 3))
        .accessibilityElement(children: .combine)
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

/// Share the booth (guests' own phones become booths too): the PIN in big type (to type it in) with a
/// copy button, and each link as a big QR code (black on white, for a phone next to the iPad to scan)
/// and a share sheet button (AirDrop, Messages, …). Settings → Share the booth, and the camera
/// screen's phone-with-plus sticker (in a sheet). It grants access, so it says so. Adult surface: words allowed.
struct ShareBoothView: View {
    let web: URL, app: URL, pin: String
    @State private var copied = false
    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                Text("Let guests use their own phone as a booth too — it prints to the same printer and their photos join the party album.")
                    .font(.title3).foregroundStyle(.black).multilineTextAlignment(.center).frame(maxWidth: 560).accessibilityIdentifier("shareIntro")
                Text("This lets them use your booth (prints, photos).").font(.headline).foregroundStyle(.black).multilineTextAlignment(.center)
                VStack(spacing: 8) {
                    Text("Booth PIN").font(.callout).foregroundStyle(.black.opacity(0.6))
                    Text(pin).font(Fonts.display(52)).foregroundStyle(.black).multilineTextAlignment(.center).textSelection(.enabled)
                        .accessibilityLabel("Booth PIN \(pin)").accessibilityIdentifier("boothPin")
                    Button { UIPasteboard.general.string = pin; copied = true } label: {
                        Label(copied ? "Copied" : "Copy PIN", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }.buttonStyle(.bordered).tint(Color.ink).accessibilityLabel("Copy PIN")
                }
                .padding(18).frame(maxWidth: 520)
                .background(RoundedRectangle(cornerRadius: 20).fill(Color.paper))
                .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.ink, lineWidth: 3))
            }
            .padding(.horizontal, 24).padding(.top, 20)
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 40) { codes }
                VStack(spacing: 40) { codes }
            }
            .padding(24).frame(maxWidth: .infinity)
            Text("Both links contain the booth PIN.")
                .font(.footnote).foregroundStyle(.black.opacity(0.6)).multilineTextAlignment(.center).padding(.horizontal, 24).padding(.bottom, 24)
        }
        .background(Color.white)
        .environment(\.colorScheme, .light)
        .navigationTitle("Share the booth")
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

/// The camera screen's "share the booth" control: a small, wordless grown-up sticker (a phone with a
/// +) at the end of the theme picker, off the camera window. Press and hold (it grants access): a tap
/// only shows "Hold to share the booth".
struct ShareBoothButton: View {
    @EnvironmentObject var booth: Booth
    var size: CGFloat = 44
    /// Which side the hint pill goes: towards the screen's middle.
    var pillSide: HorizontalEdge = .leading
    @State private var open = false
    var body: some View {
        if let links = booth.shareLinks {
            HoldButton(id: "shareBooth", a11y: "Share the booth", hint: "Hold to share the booth", size: size, tilt: -4, pillSide: pillSide) { open = true } label: {
                IconView(name: "shareBooth")
            }
                .sheet(isPresented: $open) {
                    NavigationStack {
                        ShareBoothView(web: links.web, app: links.app, pin: booth.api.pin)
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

// MARK: share this photo (kids: wordless)

/// The stage at the photo slot's aspect (4:5 when the upright photo is portrait, 4:3 when landscape,
/// turned to the screen: BoothCamera.stageAspect), fitted and centred, with room for the sticker's
/// offset shadow. Re-lays out (springs) when the device turns.
struct SlotShaped<Content: View>: View {
    @ObservedObject var camera: BoothCamera
    @ViewBuilder var content: Content
    var body: some View {
        content
            .aspectRatio(camera.stageAspect, contentMode: .fit)
            .padding(.trailing, 8).padding(.bottom, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .animation(.spring(response: 0.35, dampingFraction: 0.8), value: camera.stageAspect)
    }
}

/// "Share this photo": the strip with an arrow out of it (reads as *this photo*, not the booth).
struct ShareThisPhotoButton: View {
    @EnvironmentObject var booth: Booth
    var size: CGFloat = 96
    var body: some View {
        Button { Task { await booth.openMine() } } label: { IconView(name: "sharePhoto").frame(width: size * 0.7, height: size * 0.7).frame(width: size, height: size) }
            .buttonStyle(StickerStyle(fill: .sky, corner: 999, tilt: -5))
            .accessibilityLabel("Share this photo")
            .disabled(booth.shot == nil)
    }
}

/// "Your photos": a big QR to /s/<token> for another phone to scan, 📲 to send the files themselves
/// (share sheet: AirDrop, Messages, Save), ✖️ / tap outside to close. No words.
struct MineOverlay: View {
    @EnvironmentObject var booth: Booth
    let share: Booth.MineShare
    @State private var sending = false
    var body: some View {
        ZStack {
            Color.ink.opacity(0.6).ignoresSafeArea()
                .onTapGesture { Sfx.shared.play("boop"); booth.closeMine() }
                .accessibilityHidden(true)
            GeometryReader { g in
                let side = min(g.size.width * 0.78, g.size.height * 0.6, 460)
                VStack(spacing: 22) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 18).fill(.white)
                        if let url = share.url {
                            QRCodeView(text: url).padding(10)
                                .accessibilityElement().accessibilityAddTraits(.isImage).accessibilityLabel("QR code: Your photos")
                                .accessibilityValue(url)
                        } else if share.failed { Emoji("🙈", size: side * 0.3) } else { IconView(name: "wait").frame(width: side * 0.32, height: side * 0.32) }
                    }
                    .frame(width: side, height: side)
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.ink, lineWidth: LINE))
                    HStack(spacing: 30) {
                        Button { send() } label: { Emoji(sending ? "⏳" : "📲", size: 46).frame(width: 100, height: 100) }
                            .buttonStyle(StickerStyle(fill: .sky, corner: 999, tilt: -4)).accessibilityLabel("Send photos")
                        Button { Sfx.shared.play("boop"); booth.closeMine() } label: { IconView(name: "retake").frame(width: 70, height: 70).frame(width: 100, height: 100) }
                            .buttonStyle(StickerStyle(fill: .white, corner: 999, tilt: 4)).accessibilityLabel("Close")
                    }
                }
                .padding(24)
                .background(RoundedRectangle(cornerRadius: 28).fill(THEME_ACCENTS[booth.theme]?.0 ?? .sun))
                .overlay(RoundedRectangle(cornerRadius: 28).stroke(Color.ink, lineWidth: LINE_FAT))
                .background(RoundedRectangle(cornerRadius: 28).fill(Color.ink).offset(x: 10, y: 10))
                .frame(width: g.size.width, height: g.size.height)
            }
        }
        .transition(.scale(scale: 0.6).combined(with: .opacity))
        .accessibilityElement(children: .contain).accessibilityIdentifier("yourPhotos")
    }

    func send() {
        guard !sending else { return }
        Sfx.shared.play("tap"); sending = true
        Task {
            let items = await booth.mineImages()
            sending = false
            if items.isEmpty { Sfx.shared.play("boo") } else { presentShareSheet(items) }
        }
    }
}

/// UIActivityViewController from the top view controller (a popover on iPad, anchored low and centred).
@MainActor func presentShareSheet(_ items: [Any]) {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
          var top = scene.keyWindow?.rootViewController else { return }
    while let p = top.presentedViewController { top = p }
    let vc = UIActivityViewController(activityItems: items, applicationActivities: nil)
    if let pop = vc.popoverPresentationController {
        pop.sourceView = top.view
        pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 120, width: 1, height: 1)
        pop.permittedArrowDirections = [.down]
    }
    top.present(vc, animated: true)
}

/// Icon: a photo strip (three frames) with an arrow leaving it, in the sticker style.
struct StripArrowIcon: View {
    var body: some View {
        GeometryReader { g in
            let k = min(g.size.width, g.size.height) / 48
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 3 * k).fill(.white).frame(width: 21 * k, height: 42 * k)
                    .overlay(RoundedRectangle(cornerRadius: 3 * k).stroke(Color.ink, lineWidth: 4 * k)).offset(x: 6 * k, y: 3 * k)
                ForEach(0..<3, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1.5 * k).fill(Color.ink).frame(width: 12 * k, height: 8.5 * k)
                        .offset(x: 10.5 * k, y: (8 + Double(i) * 11.75) * k)
                }
                let arrow = Path { p in
                    p.move(to: CGPoint(x: 22 * k, y: 28 * k)); p.addLine(to: CGPoint(x: 41 * k, y: 9 * k))
                    p.move(to: CGPoint(x: 30 * k, y: 8 * k)); p.addLine(to: CGPoint(x: 42 * k, y: 8 * k)); p.addLine(to: CGPoint(x: 42 * k, y: 20 * k))
                }
                arrow.stroke(.white, style: StrokeStyle(lineWidth: 11 * k, lineCap: .round, lineJoin: .round))
                arrow.stroke(Color.ink, style: StrokeStyle(lineWidth: 5 * k, lineCap: .round, lineJoin: .round))
            }
            .frame(width: 48 * k, height: 48 * k)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// Icon: a phone with a + badge ("share the booth").
struct PhonePlusIcon: View {
    var body: some View {
        GeometryReader { g in
            let k = min(g.size.width, g.size.height) / 48
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 5 * k).fill(.white).frame(width: 24 * k, height: 41 * k)
                    .overlay(RoundedRectangle(cornerRadius: 5 * k).stroke(Color.ink, lineWidth: 4 * k)).offset(x: 9 * k, y: 3 * k)
                Capsule().fill(Color.ink).frame(width: 8 * k, height: 3 * k).offset(x: 17 * k, y: 7 * k)
                Circle().fill(Color.ink).frame(width: 4 * k, height: 4 * k).offset(x: 19 * k, y: 37 * k)
                Circle().fill(Color.mint).frame(width: 20 * k, height: 20 * k)
                    .overlay(Circle().stroke(Color.ink, lineWidth: 3.5 * k)).offset(x: 25 * k, y: 23 * k)
                Path { p in
                    p.move(to: CGPoint(x: 35 * k, y: 27.5 * k)); p.addLine(to: CGPoint(x: 35 * k, y: 38.5 * k))
                    p.move(to: CGPoint(x: 29.5 * k, y: 33 * k)); p.addLine(to: CGPoint(x: 40.5 * k, y: 33 * k))
                }.stroke(Color.ink, style: StrokeStyle(lineWidth: 4 * k, lineCap: .round))
            }
            .frame(width: 48 * k, height: 48 * k)
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// Settings → About this booth: the app's version and what the camera is doing (angles, buffer
/// sizes, orientations), plain and small, so it can be read off a real device. Settings replaces the
/// camera screen, so the camera-screen snapshot (taken as it left) comes first.
struct CameraDiagnostics: View {
    @ObservedObject var camera: BoothCamera
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = camera.diagnostics(), last = camera.lastOnScreen
            VStack(alignment: .leading, spacing: 3) {
                if !last.isEmpty {
                    Text("On the camera screen").font(.caption.bold())
                    rows(last)
                    Text("Now (settings open)").font(.caption.bold()).padding(.top, 6)
                }
                rows(now)
            }
            .textSelection(.enabled)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("cameraDiagnostics")
        }
    }
    func rows(_ r: [(String, String)]) -> some View {
        ForEach(Array(r.enumerated()), id: \.offset) { _, kv in
            HStack(alignment: .firstTextBaseline) {
                Text(kv.0).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Text(kv.1).multilineTextAlignment(.trailing)
            }.font(.caption2.monospacedDigit())
        }
    }
}

// MARK: first-run coach (kids: wordless)

/// Controls the first-run coach can point at, by name ("shutter", "print").
struct CoachTargets: PreferenceKey {
    static let defaultValue: [String: Anchor<CGRect>] = [:]
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) { value.merge(nextValue()) { $1 } }
}
extension View {
    func coachTarget(_ name: String) -> some View { anchorPreference(key: CoachTargets.self, value: .bounds) { [name: $0] } }
}

/// A soft spotlight on the control to tap and the drawn pointing hand poking down at it (DESIGN.md
/// "First-run coach"). No words; taps pass straight through.
struct CoachOverlay: View {
    let step: String
    let target: CGRect
    let size: CGSize
    @State private var poke = false
    var body: some View {
        let r = max(target.width, target.height) / 2 + 12, R = max(size.width, size.height) * 1.5
        ZStack(alignment: .topLeading) {
            RadialGradient(stops: [.init(color: .clear, location: r / R), .init(color: Color.ink.opacity(0.42), location: (r + 28) / R)],
                           center: UnitPoint(x: target.midX / max(size.width, 1), y: target.midY / max(size.height, 1)), startRadius: 0, endRadius: R)
                .frame(width: size.width, height: size.height)
            IconView(name: "point").frame(width: 100, height: 100)
                .position(x: target.midX, y: target.midY - r - 50 + 4)
                .offset(y: poke ? 16 : 0)
                .accessibilityElement().accessibilityIdentifier("coachHand").accessibilityLabel("Tap here").accessibilityValue(step)
        }
        .transition(.opacity)
        .onAppear { withAnimation(.easeInOut(duration: 0.45).repeatForever(autoreverses: true)) { poke = true } }
    }
}

