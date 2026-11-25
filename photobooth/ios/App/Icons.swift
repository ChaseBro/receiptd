// Drawn icons ("Thermal Arcade" stickers), mirroring public/icons.js: the same 100×100 box, the
// same shapes and numbers (ported function by function from the approved booth sketch), drawn
// with SwiftUI Canvas. Thick ink outline, hard offset ink shadow (4 units, no blur), candy fills,
// Lilita numerals. Settings → Icon style: Drawn (default) or Classic (the emoji used before).
// Theme-picker icons stay emoji either way.

import SwiftUI
import BoothCore

enum IconStyle: String { case drawn, classic }

/// An icon in the chosen style. `arg`: the place-in-line number for "queue".
struct IconView: View {
    let name: String
    var arg: Int? = nil
    @EnvironmentObject var booth: Booth
    var body: some View {
        if booth.iconStyle == .classic { ClassicIcon(name: name) } else { DrawnIcon(name: name, arg: arg) }
    }
}

/// The emoji (or the two small line icons) the booth used before.
struct ClassicIcon: View {
    let name: String
    static let emoji: [String: String] = [
        "shutter": "📸", "flip": "🔄", "nocam": "🙈", "gear": "⚙️", "wait": "⏳", "retake": "✖️", "print": "🖨️", "rotate": "↻",
        "receipt": "🧾", "minus": "➖", "plus": "➕", "again": "🔁", "back": "✖️", "queue": "⏳", "done": "🎉", "upload": "☁️",
        "party": "🎉", "paperOk": "🧻", "pReady": "😺", "pPrinting": "😺", "pOffline": "🔌", "pPaperOut": "🧻", "pPaperLow": "🧻",
        "pCover": "🖨️", "pError": "💥",
    ]
    var body: some View {
        GeometryReader { g in
            let side = min(g.size.width, g.size.height)
            Group {
                switch name {
                case "one": StripIcon(shots: 1).scaleEffect(side / 60)
                case "three": StripIcon(shots: 3).scaleEffect(side / 70)
                case "makeBooth": PhonePlusIcon()
                case "sharePhoto": StripArrowIcon()
                default: Text(ClassicIcon.emoji[name] ?? "").font(.system(size: side * 0.62)).minimumScaleFactor(0.3).lineLimit(1)
                }
            }
            .frame(width: g.size.width, height: g.size.height)
        }
        .accessibilityHidden(true)
    }
}

/// A drawn icon, fitted into its frame (square), with the hard ink shadow.
struct DrawnIcon: View {
    let name: String
    var arg: Int? = nil
    var body: some View {
        SwiftUI.Canvas { ctx, size in
            let s = min(size.width, size.height) / 100
            var c = ctx
            c.translateBy(x: (size.width - 100 * s) / 2, y: (size.height - 100 * s) / 2)
            c.scaleBy(x: s, y: s)
            // Hard shadow: the whole drawing as an ink silhouette, offset 4 units (public/icons.js #ic-hs).
            var sh = c
            sh.translateBy(x: 4, y: 4)
            sh.addFilter(.colorMatrix(Icons.inkMatrix))
            sh.drawLayer { l in Icons.draw(name, arg, Pen(ctx: l)) }
            c.drawLayer { l in Icons.draw(name, arg, Pen(ctx: l)) }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

// MARK: - drawing primitives (an SVG subset)

/// stroke="ink" stroke-width=w, round joins + caps (the sketch's `st(w)`).
struct Stroke { var color: Color = .ink; var width: CGFloat; var cap: CGLineCap = .round; var join: CGLineJoin = .round; var dash: [CGFloat] = [] }
func st(_ w: CGFloat = 6) -> Stroke { Stroke(width: w) }

struct Pen {
    var ctx: GraphicsContext

    func paint(_ p: Path, fill: Color?, stroke: Stroke?) {
        if let fill { ctx.fill(p, with: .color(fill)) }
        if let s = stroke { ctx.stroke(p, with: .color(s.color), style: StrokeStyle(lineWidth: s.width, lineCap: s.cap, lineJoin: s.join, dash: s.dash)) }
    }
    func path(_ d: String, fill: Color? = nil, stroke: Stroke? = nil) { paint(SVGPath.parse(d), fill: fill, stroke: stroke) }
    func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, rx: CGFloat = 0, fill: Color? = nil, stroke: Stroke? = nil) {
        let r = CGRect(x: x, y: y, width: w, height: h)
        paint(rx > 0 ? Path(roundedRect: r, cornerRadius: rx, style: .circular) : Path(r), fill: fill, stroke: stroke)
    }
    func circle(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat, fill: Color? = nil, stroke: Stroke? = nil) {
        paint(Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: 2 * r, height: 2 * r)), fill: fill, stroke: stroke)
    }
    func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat, fill: Color? = nil) {
        paint(Path(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry)), fill: fill, stroke: nil)
    }
    func polygon(_ pts: [CGPoint], fill: Color? = nil, stroke: Stroke? = nil) {
        var p = Path(); p.addLines(pts); p.closeSubpath(); paint(p, fill: fill, stroke: stroke)
    }
    /// "Outlined stroke": a fat ink line under a thinner colour line (the sketch's `ol`).
    func ol(_ d: String, _ c: Color, _ w: CGFloat = 10) {
        path(d, stroke: Stroke(width: w + 11)); path(d, stroke: Stroke(color: c, width: w))
    }
    /// A Lilita numeral centred on (x, y) (the sketch's text-anchor="middle", baseline y + 0.52 r).
    func text(_ x: CGFloat, _ y: CGFloat, _ s: String, size: CGFloat) {
        ctx.draw(Text(s).font(Fonts.display(size)).foregroundColor(.ink), at: CGPoint(x: x, y: y + size * 0.04), anchor: .center)
    }
    /// transform="rotate(a cx cy)"
    func rotated(_ a: Double, _ cx: CGFloat, _ cy: CGFloat, _ body: (Pen) -> Void) {
        var c = ctx; c.translateBy(x: cx, y: cy); c.rotate(by: .degrees(a)); c.translateBy(x: -cx, y: -cy); body(Pen(ctx: c))
    }
    /// transform="translate(tx ty) scale(s)"
    func scaled(_ s: CGFloat, _ tx: CGFloat, _ ty: CGFloat, _ body: (Pen) -> Void) {
        var c = ctx; c.translateBy(x: tx, y: ty); c.scaleBy(x: s, y: s); body(Pen(ctx: c))
    }
}

/// Minimal SVG path-data parser: M L H V C Q T A Z, absolute and relative. Arcs are circular
/// (rx = ry, no rotation: all the icons need) and become cubic Béziers.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var toks: [String] = []
        var cur = ""
        func flush() { if !cur.isEmpty { toks.append(cur); cur = "" } }
        for ch in d {
            if ch.isLetter && ch != "e" { flush(); toks.append(String(ch)) }
            else if ch == "," || ch == " " || ch == "\n" || ch == "\t" { flush() }
            else if ch == "-" && !cur.isEmpty && cur.last != "e" { flush(); cur.append(ch) }
            else if ch == "." && cur.contains(".") { flush(); cur.append(ch) }
            else { cur.append(ch) }
        }
        flush()
        var p = Path(), i = 0, cmd: Character = "M"
        var pt = CGPoint.zero, start = CGPoint.zero, lastCtl: CGPoint? = nil
        func num() -> CGFloat { defer { i += 1 }; return CGFloat(Double(toks[i]) ?? 0) }
        while i < toks.count {
            if let c = toks[i].first, c.isLetter { cmd = c; i += 1; if c == "Z" || c == "z" { p.closeSubpath(); pt = start; lastCtl = nil; continue } }
            guard i < toks.count else { break }
            let rel = cmd.isLowercase
            let o = rel ? pt : .zero
            switch cmd.uppercased() {
            case "M":
                pt = CGPoint(x: o.x + num(), y: o.y + num()); p.move(to: pt); start = pt; lastCtl = nil
                cmd = rel ? "l" : "L"   // further pairs are line-tos
            case "L": pt = CGPoint(x: o.x + num(), y: o.y + num()); p.addLine(to: pt); lastCtl = nil
            case "H": pt = CGPoint(x: (rel ? pt.x : 0) + num(), y: pt.y); p.addLine(to: pt); lastCtl = nil
            case "V": pt = CGPoint(x: pt.x, y: (rel ? pt.y : 0) + num()); p.addLine(to: pt); lastCtl = nil
            case "C":
                let c1 = CGPoint(x: o.x + num(), y: o.y + num()), c2 = CGPoint(x: o.x + num(), y: o.y + num())
                pt = CGPoint(x: o.x + num(), y: o.y + num()); p.addCurve(to: pt, control1: c1, control2: c2); lastCtl = nil
            case "Q":
                let c1 = CGPoint(x: o.x + num(), y: o.y + num())
                pt = CGPoint(x: o.x + num(), y: o.y + num()); p.addQuadCurve(to: pt, control: c1); lastCtl = c1
            case "T":
                let c1 = lastCtl.map { CGPoint(x: 2 * pt.x - $0.x, y: 2 * pt.y - $0.y) } ?? pt
                pt = CGPoint(x: o.x + num(), y: o.y + num()); p.addQuadCurve(to: pt, control: c1); lastCtl = c1
            case "A":
                let r = num(); _ = num(); _ = num()
                let large = num() != 0, sweep = num() != 0
                let end = CGPoint(x: o.x + num(), y: o.y + num())
                arc(&p, from: pt, to: end, r: r, large: large, sweep: sweep); pt = end; lastCtl = nil
            default: i += 1
            }
        }
        return p
    }

    /// SVG endpoint arc (circular) → Béziers of ≤ 90° each.
    static func arc(_ p: inout Path, from a: CGPoint, to b: CGPoint, r r0: CGFloat, large: Bool, sweep: Bool) {
        let x1 = (a.x - b.x) / 2, y1 = (a.y - b.y) / 2
        var r = abs(r0)
        let lambda = (x1 * x1 + y1 * y1) / (r * r)
        if lambda > 1 { r *= sqrt(lambda) }
        let num = max(0, r * r * r * r - r * r * y1 * y1 - r * r * x1 * x1), den = r * r * y1 * y1 + r * r * x1 * x1
        let coef = (large != sweep ? 1 : -1) * (den == 0 ? 0 : sqrt(num / den))
        let cxp = coef * y1, cyp = -coef * x1
        let c = CGPoint(x: cxp + (a.x + b.x) / 2, y: cyp + (a.y + b.y) / 2)
        let t1 = atan2((y1 - cyp) / r, (x1 - cxp) / r), t2 = atan2((-y1 - cyp) / r, (-x1 - cxp) / r)
        var dt = t2 - t1
        if !sweep && dt > 0 { dt -= 2 * .pi } else if sweep && dt < 0 { dt += 2 * .pi }
        let n = max(1, Int(ceil(abs(dt) / (.pi / 2) - 1e-9))), seg = dt / CGFloat(n)
        var t = t1
        for _ in 0..<n {
            let k = 4.0 / 3.0 * tan(seg / 4)
            let p0 = CGPoint(x: c.x + r * cos(t), y: c.y + r * sin(t)), p3 = CGPoint(x: c.x + r * cos(t + seg), y: c.y + r * sin(t + seg))
            let c1 = CGPoint(x: p0.x - k * r * sin(t), y: p0.y + k * r * cos(t))
            let c2 = CGPoint(x: p3.x + k * r * sin(t + seg), y: p3.y - k * r * cos(t + seg))
            p.addCurve(to: p3, control1: c1, control2: c2)
            t += seg
        }
    }
}

// MARK: - the icons (public/icons.js, function by function)

enum Icons {
    /// Everything → ink (#1A1423), alpha kept: the hard shadow's silhouette.
    static let inkMatrix: ColorMatrix = {
        var m = ColorMatrix()
        m.r1 = 0; m.r2 = 0; m.r3 = 0; m.r4 = 0; m.r5 = 0x1A / 255
        m.g1 = 0; m.g2 = 0; m.g3 = 0; m.g4 = 0; m.g5 = 0x14 / 255
        m.b1 = 0; m.b2 = 0; m.b3 = 0; m.b4 = 0; m.b5 = 0x23 / 255
        m.a1 = 0; m.a2 = 0; m.a3 = 0; m.a4 = 1; m.a5 = 0
        return m
    }()
    static let names = ["shutter", "flip", "one", "three", "nocam", "gear", "makeBooth", "sharePhoto", "wait", "queue", "retake", "print",
                        "rotate", "receipt", "minus", "plus", "again", "back", "done", "pReady", "pPrinting", "pOffline", "pPaperOut",
                        "pPaperLow", "pCover", "pError", "paperOk", "upload", "party"]

    static func rad(_ a: Double) -> Double { a * .pi / 180 }
    static func pt(_ cx: Double, _ cy: Double, _ r: Double, _ a: Double) -> CGPoint { CGPoint(x: cx + r * cos(rad(a)), y: cy + r * sin(rad(a))) }
    static func f(_ v: CGFloat) -> String { String(format: "%.1f", Double(v)) }

    static func arcArrow(_ p: Pen, _ cx: Double, _ cy: Double, _ r: Double, _ a0: Double, _ a1: Double, _ c: Color, _ w: CGFloat = 10, _ hs: Double = 1) {
        let s = pt(cx, cy, r, a0), e = pt(cx, cy, r, a1)
        let sweep = a1 > a0 ? 1 : 0, large = abs(a1 - a0) > 180 ? 1 : 0
        let d = "M\(f(s.x)) \(f(s.y)) A\(r) \(r) 0 \(large) \(sweep) \(f(e.x)) \(f(e.y))"
        let dir = a1 + (sweep == 1 ? 90 : -90), ux = cos(rad(dir)), uy = sin(rad(dir)), nx = -uy, ny = ux
        let L = 13 * hs, W = 12 * hs
        let tip = CGPoint(x: e.x + ux * L, y: e.y + uy * L)
        let b1 = CGPoint(x: e.x - ux * 3 + nx * W, y: e.y - uy * 3 + ny * W), b2 = CGPoint(x: e.x - ux * 3 - nx * W, y: e.y - uy * 3 - ny * W)
        p.path(d, stroke: Stroke(width: w + 11, join: .miter))
        p.polygon([tip, b1, b2], fill: c, stroke: st(5.5))
        p.path(d, stroke: Stroke(color: c, width: w, join: .miter))
    }
    static func starPts(_ cx: Double, _ cy: Double, _ ro: Double, _ ri: Double, _ n: Int, _ rot: Double = 0) -> [CGPoint] {
        (0..<(2 * n)).map { i in pt(cx, cy, i % 2 == 1 ? ri : ro, rot + 180 * Double(i) / Double(n) - 90) }
    }
    static func spark(_ p: Pen, _ x: Double, _ y: Double, _ s: Double = 1, _ c: Color = .sun) { p.polygon(starPts(x, y, 10 * s, 4.2 * s, 4), fill: c, stroke: st(3.5)) }
    static func bang(_ p: Pen, _ x: CGFloat, _ y: CGFloat, _ c: Color = .sun) {
        p.circle(x, y, 12, fill: c, stroke: st(4.5)); p.path("M\(x) \(y - 6) V\(y + 1)", stroke: st(5)); p.circle(x, y + 6, 2.6, fill: .ink)
    }
    static func numBadge(_ p: Pen, _ x: CGFloat, _ y: CGFloat, _ n: Int, _ c: Color = .sun, _ r: CGFloat = 13) {
        p.circle(x, y, r, fill: c, stroke: st(4.5)); p.text(x, y, "\(n)", size: r * 1.55)
    }

    static func camera(_ p: Pen, star: Bool = true, tilt: Double = -6) {
        p.rotated(tilt, 50, 56) { p in
            p.rect(27, 19, 26, 17, rx: 5, fill: .pink, stroke: st())
            p.rect(12, 30, 76, 56, rx: 13, fill: .tomato)
            p.path("M12 56 V43 A13 13 0 0 1 25 30 H75 A13 13 0 0 1 88 43 V56 Z", fill: .pink)
            p.path("M12 56 H88", stroke: st(4))
            p.rect(12, 30, 76, 56, rx: 13, stroke: st())
            p.circle(50, 58, 21, fill: .white, stroke: st())
            p.circle(50, 58, 12.5, fill: .sky, stroke: st(5))
            p.circle(46, 54, 3.6, fill: .white); p.circle(54.5, 62, 1.8, fill: .white)
        }
        if star { p.polygon(starPts(82, 20, 15, 6.5, 8, 10), fill: .sun, stroke: st(4)); p.circle(82, 20, 4, fill: .white) }
    }
    static func zigzag(_ x0: CGFloat, _ w: CGFloat, _ y1: CGFloat, _ teeth: Int) -> String {
        let tw = w / CGFloat(teeth)
        return (0..<teeth).map { i in " L\(f(x0 + w - tw * CGFloat(i) - tw / 2)) \(y1 + 7) L\(f(x0 + w - tw * CGFloat(i + 1))) \(y1)" }.joined()
    }
    static func receiptShape(_ p: Pen, _ x0: CGFloat, _ y0: CGFloat, _ w: CGFloat, _ y1: CGFloat, fill: Color = .paper, teeth: Int = 6) {
        p.path("M\(x0) \(y0) H\(x0 + w) V\(y1)\(zigzag(x0, w, y1, teeth)) Z", fill: fill, stroke: st())
    }
    static func frame(_ p: Pen, _ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
        p.rect(x, y, w, h, rx: 3, fill: .sky, stroke: st(4))
        p.circle(x + w / 2, y + h * 0.45, h * 0.17, fill: .ink)
        p.path("M\(f(x + w / 2 - h * 0.32)) \(y + h - 1) Q\(x + w / 2) \(y + h * 0.5) \(f(x + w / 2 + h * 0.32)) \(y + h - 1)", fill: .ink)
    }
    static func strip(_ p: Pen, _ n: Int) {
        let x0: CGFloat = 28, w: CGFloat = 42, y0: CGFloat = n == 3 ? 8 : 22, y1: CGFloat = n == 3 ? 84 : 72
        p.rotated(-5, 50, 50) { p in
            p.path("M\(x0) \(y0) H\(x0 + w) V\(y1)\(zigzag(x0, w, y1, 6)) Z", fill: .paper, stroke: st())
            if n == 3 { for y in [15, 38, 61] as [CGFloat] { frame(p, x0 + 7, y, w - 14, 18) } } else { frame(p, x0 + 7, 30, w - 14, 32) }
        }
        numBadge(p, 76, 20, n, .sun, 15)
    }

    enum Face { case happy, sleep, worried, oh, x }
    static func printer(_ p: Pen, lid: String = "closed", paper: String = "none", face: Face = .happy, led: Color = .mint, fill: Color = .white, lidFill: Color = .sky) {
        if paper == "strip" {
            p.rotated(-4, 50, 30) { p in
                receiptShape(p, 31, 4, 38, 30, fill: .white, teeth: 5)
                p.rect(38, 8, 24, 15, rx: 3, fill: .sky, stroke: st(4)); p.circle(50, 14, 3, fill: .ink)
            }
        }
        if paper == "tongue" { p.rect(34, 20, 32, 16, fill: .white, stroke: st(5)) }
        if lid == "open" {
            p.rect(16, 36, 68, 12, rx: 4, fill: .ink)
            p.circle(50, 40, 13, fill: .white, stroke: st(5)); p.circle(50, 40, 4.5, fill: .paper, stroke: st(3.5))
        }
        p.rect(12, 42, 76, 44, rx: 12, fill: fill, stroke: st())
        if lid == "closed" { p.rect(17, 29, 66, 17, rx: 7, fill: lidFill, stroke: st()) }
        else { p.rotated(-48, 17, 44) { p in p.rect(17, 29, 66, 15, rx: 7, fill: lidFill, stroke: st()) } }
        p.circle(77, 76, 4.5, fill: led, stroke: st(3.5))
        let l: CGFloat = 36, r: CGFloat = 60, y: CGFloat = 62, m: CGFloat = 48
        switch face {
        case .happy:
            p.path("M\(l - 5) \(y + 2) Q\(l) \(y - 5) \(l + 5) \(y + 2) M\(r - 5) \(y + 2) Q\(r) \(y - 5) \(r + 5) \(y + 2)", stroke: st(4.5))
            p.path("M\(m - 7) \(y + 9) Q\(m) \(y + 17) \(m + 7) \(y + 9) Z", fill: .ink, stroke: st(3))
        case .sleep:
            p.path("M\(l - 5) \(y) Q\(l) \(y + 4) \(l + 5) \(y) M\(r - 5) \(y) Q\(r) \(y + 4) \(r + 5) \(y)", stroke: st(4.5))
            p.circle(m, y + 12, 3, fill: .ink)
        case .worried:
            p.circle(l, y + 1, 3.4, fill: .ink); p.circle(r, y + 1, 3.4, fill: .ink)
            p.path("M\(l - 6) \(y - 8) L\(l + 4) \(y - 5) M\(r + 6) \(y - 8) L\(r - 4) \(y - 5)", stroke: st(4))
            p.path("M\(m - 7) \(y + 14) Q\(m) \(y + 8) \(m + 7) \(y + 14)", stroke: st(4.5))
        case .oh:
            p.circle(l, y, 3.6, fill: .ink); p.circle(r, y, 3.6, fill: .ink); p.ellipse(m, y + 12, 4, 5, fill: .ink)
        case .x:
            p.path("M\(l - 5) \(y - 5) L\(l + 5) \(y + 5) M\(l + 5) \(y - 5) L\(l - 5) \(y + 5) M\(r - 5) \(y - 5) L\(r + 5) \(y + 5) M\(r + 5) \(y - 5) L\(r - 5) \(y + 5)", stroke: st(4.5))
            p.path("M\(m - 9) \(y + 13) q3 -4 6 0 t6 0 t6 0", stroke: st(4))
        }
    }
    static func zz(_ p: Pen, _ x: CGFloat, _ y: CGFloat, _ s: CGFloat) {
        let d = "M\(x) \(y) h\(7 * s) l\(-7 * s) \(8 * s) h\(7 * s)"
        p.path(d, stroke: Stroke(width: 8 * s + 4)); p.path(d, stroke: Stroke(color: .grape, width: 4.5 * s))
    }
    static func gearPts(_ cx: Double, _ cy: Double, _ ro: Double, _ ri: Double, _ n: Int) -> [CGPoint] {
        let tw = 360 / Double(n)
        return (0..<n).flatMap { i -> [CGPoint] in
            let a = Double(i) * tw - 90
            return [(a - tw * 0.5, ri), (a - tw * 0.2, ri), (a - tw * 0.13, ro), (a + tw * 0.13, ro), (a + tw * 0.2, ri)].map { pt(cx, cy, $0.1, $0.0) }
        }
    }
    static func hourglass(_ p: Pen) {
        p.rotated(8, 50, 50) { p in
            let body = "M30 22 C30 42 45 45 45 50 C45 55 30 58 30 78 H70 C70 58 55 55 55 50 C55 45 70 42 70 22 Z"
            p.path(body, fill: .white, stroke: st())
            p.path("M37 33 H63 C60 40 52 44 50 47 C48 44 40 40 37 33 Z", fill: .sun)
            p.path("M50 49 V66", stroke: Stroke(color: .sun, width: 3.5))
            p.path("M35 76 Q50 60 65 76 Z", fill: .sun)
            p.path(body, stroke: st())
            p.rect(22, 11, 56, 11, rx: 5, fill: .grape, stroke: st())
            p.rect(22, 78, 56, 11, rx: 5, fill: .grape, stroke: st())
        }
    }
    static func photoCard(_ p: Pen, _ tilt: Double = -10) {
        p.rotated(tilt, 50, 58) { p in
            p.rect(27, 32, 46, 52, rx: 5, fill: .white, stroke: st())
            p.rect(33, 38, 34, 30, rx: 3, fill: .sky, stroke: st(4)); p.circle(50, 50, 5, fill: .ink); p.path("M40 67 Q50 53 60 67", fill: .ink)
        }
    }

    static func draw(_ name: String, _ arg: Int?, _ p: Pen) {
        switch name {
        case "shutter": camera(p)
        case "flip":
            p.scaled(0.54, 23, 21) { camera($0, star: false, tilt: 0) }
            arcArrow(p, 50, 52, 40, 200, 290, .sun, 9, 0.85); arcArrow(p, 50, 52, 40, 20, 110, .sun, 9, 0.85)
        case "one": strip(p, 1)
        case "three": strip(p, 3)
        case "nocam": p.scaled(0.9, 5, 2) { camera($0, star: false, tilt: -6) }; p.ol("M16 16 L84 84", .tomato, 10)
        case "gear":
            p.rotated(10, 50, 50) { p in p.polygon(gearPts(50, 50, 41, 30, 8), fill: .grape, stroke: st()); p.circle(50, 50, 12, fill: .white, stroke: st()) }
        case "makeBooth":
            p.rotated(-6, 50, 50) { p in
                p.rect(22, 8, 44, 80, rx: 10, fill: .white, stroke: st())
                p.rect(29, 20, 30, 50, rx: 4, fill: .sky, stroke: st(4)); p.path("M38 14 H50", stroke: st(4.5)); p.circle(44, 79, 3.5, fill: .ink)
            }
            p.circle(72, 70, 20, fill: .mint, stroke: st()); p.ol("M72 60 V80 M62 70 H82", .white, 6)
        case "sharePhoto":
            p.rotated(-6, 50, 50) { p in receiptShape(p, 14, 8, 40, 82); frame(p, 20, 15, 28, 18); frame(p, 20, 38, 28, 18); frame(p, 20, 61, 28, 16) }
            p.ol("M48 58 L80 26 M60 22 H84 V46", .white, 8)
        case "wait": hourglass(p)
        case "queue": hourglass(p); numBadge(p, 78, 78, arg ?? 2, .sky, 15)
        case "retake": p.ol("M30 30 L70 70 M70 30 L30 70", .white, 13)
        case "print": printer(p, paper: "strip"); spark(p, 88, 14, 0.9); spark(p, 14, 22, 0.65, .pink)
        case "rotate": photoCard(p, -8); arcArrow(p, 50, 58, 42, 205, 300, .sun, 9, 0.9)
        case "receipt":
            p.rotated(-6, 50, 50) { p in receiptShape(p, 28, 10, 44, 80); p.path("M36 24 H64 M36 36 H58 M36 48 H64 M36 60 H52", stroke: st(4.5)) }
        case "minus": p.ol("M27 50 H73", .white, 13)
        case "plus": p.ol("M27 50 H73 M50 27 V73", .white, 13)
        case "again": arcArrow(p, 50, 52, 28, -50, 235, .sun, 11)
        case "back": p.ol("M72 50 H30 M47 32 L29 50 L47 68", .white, 13)
        case "done":
            p.rotated(-6, 50, 50) { p in
                receiptShape(p, 20, 8, 42, 80); p.rect(27, 16, 28, 20, rx: 3, fill: .sky, stroke: st(4)); p.rect(27, 44, 28, 20, rx: 3, fill: .sky, stroke: st(4))
            }
            p.circle(68, 66, 21, fill: .mint, stroke: st()); p.ol("M58 66 L66 74 L79 58", .white, 7); spark(p, 84, 18, 1); spark(p, 12, 88, 0.7, .pink)
        case "pReady": printer(p, paper: "tongue")
        case "pPrinting": printer(p, paper: "strip"); p.path("M22 12 H14 M22 22 H10 M78 12 H86 M78 22 H90", stroke: st(4.5))
        case "pOffline":
            p.scaled(0.74, -2, -10) { printer($0, face: .sleep, led: .paper) }
            p.path("M60 48 C84 46 88 62 76 74", stroke: Stroke(width: 9, join: .miter))
            p.rect(58, 72, 28, 22, rx: 6, fill: .grape, stroke: st(5)); p.path("M58 78 H48 M58 88 H48", stroke: st(6))
            p.rect(6, 68, 30, 28, rx: 7, fill: .white, stroke: st(5)); p.rect(14, 76, 4.5, 11, rx: 1.5, fill: .ink); p.rect(24, 76, 4.5, 11, rx: 1.5, fill: .ink)
            zz(p, 74, 2, 1.25)
        case "pPaperOut":
            p.scaled(0.8, -2, 14) { printer($0, face: .worried, led: .sun) }
            p.circle(74, 24, 18, fill: .white, stroke: Stroke(width: 4, cap: .butt, join: .miter, dash: [6, 5]))
            p.circle(74, 24, 8, fill: .sun, stroke: st(4.5)); p.circle(74, 24, 3, fill: .ink); bang(p, 88, 84)
        case "pPaperLow":
            p.scaled(0.8, -2, 14) { printer($0, face: .oh, led: .sun) }
            p.circle(74, 24, 12, fill: .white, stroke: st(4.5)); p.circle(74, 24, 8, fill: .sun, stroke: st(4)); p.circle(74, 24, 3, fill: .ink)
        case "pCover":
            printer(p, lid: "open", face: .oh, led: .sun); p.path("M76 10 q6 4 6 12 M86 6 q8 6 8 18", stroke: st(4.5)); bang(p, 88, 92)
        case "pError":
            printer(p, face: .x, led: .tomato)
            for (x, y, r) in [(34.0, 16.0, 8.0), (46, 10, 9), (56, 17, 7)] as [(CGFloat, CGFloat, CGFloat)] { p.circle(x, y, r, fill: .white, stroke: st(4.5)) }
            p.polygon([(70, 4), (62, 20), (70, 20), (64, 32), (80, 14), (72, 14), (78, 4)].map { CGPoint(x: $0.0, y: $0.1) }, fill: .sun, stroke: st(4))
            bang(p, 88, 92, .tomato)
        case "paperOk":
            p.circle(50, 50, 32, fill: .white, stroke: st()); p.circle(50, 50, 12, fill: .sun, stroke: st(5)); p.circle(50, 50, 4, fill: .ink)
            p.path("M50 82 H86 V70", stroke: st())
        case "upload":
            p.path("M24 72 Q10 72 12 58 Q14 46 28 47 Q30 28 50 28 Q68 28 72 44 Q90 42 90 58 Q90 72 76 72 Z", fill: .white, stroke: st())
            p.ol("M50 76 V48 M40 58 L50 47 L60 58", .sky, 8)
        case "party":
            let tri = [CGPoint(x: 20, y: 84), CGPoint(x: 40, y: 24), CGPoint(x: 78, y: 62)]
            p.polygon(tri, fill: .pink, stroke: st()); p.path("M30 54 L58 72 M35 39 L68 62", stroke: Stroke(color: .sun, width: 6, cap: .butt, join: .miter))
            p.polygon(tri, stroke: st()); spark(p, 70, 22, 1); spark(p, 88, 46, 0.6, .sky); p.circle(54, 12, 5, fill: .mint, stroke: st(3.5))
        default: break
        }
    }
}
