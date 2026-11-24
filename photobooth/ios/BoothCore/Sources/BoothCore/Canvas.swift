// A Canvas 2D look-alike over CoreGraphics, just enough for frames.js.
//
// WebKit's canvas *is* CoreGraphics (GraphicsContextCG), so issuing the same
// CG calls WebKit issues gives the same pixels. The parts that matter for
// byte-identical strips:
//   • geometry passes through Float (WebKit's canvas path API takes float),
//     transforms stay Double (AffineTransform is double);
//   • the path lives in user space and is re-expressed through the inverse
//     when the transform changes (CanvasPath), then added under the CTM;
//   • arcs/ellipses/roundRects are built the way WebKit's PathCG builds them;
//   • text: per-glyph advances, no kerning, font smoothing on, baseline from
//     the primary font's ascent/descent;
//   • bitmap: sRGB, 8-bit premultiplied BGRA, y-down CTM.
// Anything new used by frames.js needs a parity fixture (../parity).

import CoreGraphics
import CoreText
import Foundation

public enum TextAlign { case start, left, center, right, end }
public enum TextBaseline { case alphabetic, middle, top, bottom }
public enum LineCap { case butt, round, square }
public enum LineJoin { case miter, round, bevel }

/// A font stack, like `34px "Lilita", "Arial Rounded MT Bold", sans-serif`.
public struct CanvasFont {
    public var size: Double
    public var emoji: Bool
    public static func display(_ size: Double) -> CanvasFont { CanvasFont(size: size, emoji: false) }
    public static func emoji(_ size: Double) -> CanvasFont { CanvasFont(size: size, emoji: true) }
}

public final class Canvas {
    public let width: Int, height: Int
    public let ctx: CGContext

    private struct TextState { var font = CanvasFont.display(10); var align = TextAlign.start; var baseline = TextBaseline.alphabetic }
    private var text = TextState()
    private var textStack: [TextState] = []
    private var transform = CGAffineTransform.identity
    private var transformStack: [CGAffineTransform] = []
    private var path = CGMutablePath()
    private var lineWidthValue = 1.0
    private var lineWidthStack: [Double] = []

    public init(_ width: Int, _ height: Int) {
        self.width = width; self.height = height
        ctx = CGContext(data: nil, width: max(1, width), height: max(1, height), bitsPerComponent: 8, bytesPerRow: max(1, width) * 4,
                        space: Canvas.srgb, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        ctx.clear(CGRect(x: 0, y: 0, width: max(1, width), height: max(1, height)))   // transparent black, like a new canvas
        ctx.translateBy(x: 0, y: CGFloat(height)); ctx.scaleBy(x: 1, y: -1)
        ctx.setShouldSmoothFonts(true)
        ctx.interpolationQuality = .low   // imageSmoothingQuality "low" (canvas default)
        ctx.setMiterLimit(10)
    }

    static let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

    // MARK: colours (print art is ink only; calibration needs greys)

    public static let ink = CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
    public static let paper = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
    public static func gray(_ v: Int) -> CGColor { let c = CGFloat(v) / 255; return CGColor(srgbRed: c, green: c, blue: c, alpha: 1) }

    public func fillStyle(_ c: CGColor) { ctx.setFillColor(c) }
    public func strokeStyle(_ c: CGColor) { ctx.setStrokeColor(c) }
    public var lineWidth: Double {
        get { lineWidthValue }
        set { guard newValue > 0, newValue.isFinite else { return }; lineWidthValue = newValue; ctx.setLineWidth(CGFloat(Float(newValue))) }
    }
    public func lineCap(_ c: LineCap) { ctx.setLineCap(c == .butt ? .butt : c == .round ? .round : .square) }
    public func lineJoin(_ j: LineJoin) { ctx.setLineJoin(j == .miter ? .miter : j == .round ? .round : .bevel) }
    public func setLineDash(_ d: [Double]) { ctx.setLineDash(phase: 0, lengths: d.map { CGFloat(Float($0)) }) }
    public func font(_ f: CanvasFont) { text.font = f }
    public func textAlign(_ a: TextAlign) { text.align = a }
    public func textBaseline(_ b: TextBaseline) { text.baseline = b }
    public func sourceIn() { ctx.setBlendMode(.sourceIn) }

    // MARK: state

    public func save() {
        ctx.saveGState(); textStack.append(text); transformStack.append(transform); lineWidthStack.append(lineWidthValue)
    }
    public func restore() {
        guard let t = transformStack.popLast() else { return }
        ctx.restoreGState(); text = textStack.removeLast(); lineWidthValue = lineWidthStack.removeLast()
        if t != transform { reexpressPath(from: transform, to: t) }
        transform = t
    }

    // MARK: transforms

    // GraphicsContext::translate/rotate/scale take float; the canvas state's
    // own transform (used for the path) stays double.
    public func translate(_ x: Double, _ y: Double) {
        let t = transform.translatedBy(x: x, y: y)
        ctx.translateBy(x: CGFloat(Float(x)), y: CGFloat(Float(y))); reexpressPath(from: transform, to: t); transform = t
    }
    public func rotate(_ a: Double) {
        let t = transform.rotated(by: a)
        ctx.rotate(by: CGFloat(Float(a))); reexpressPath(from: transform, to: t); transform = t
    }
    public func scale(_ x: Double, _ y: Double) {
        let t = transform.scaledBy(x: x, y: y)
        ctx.scaleBy(x: CGFloat(Float(x)), y: CGFloat(Float(y))); reexpressPath(from: transform, to: t); transform = t
    }
    /// CanvasPath keeps the path in the current user space: map it through old·new⁻¹.
    private func reexpressPath(from old: CGAffineTransform, to new: CGAffineTransform) {
        guard !path.isEmpty else { return }
        var m = old.concatenating(new.inverted())
        if let p = path.copy(using: &m) { path = p.mutableCopy()! }
    }

    // MARK: paths

    @inline(__always) private func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: CGFloat(Float(x)), y: CGFloat(Float(y))) }

    public func beginPath() { path = CGMutablePath() }
    public func moveTo(_ x: Double, _ y: Double) { path.move(to: pt(x, y)) }
    public func lineTo(_ x: Double, _ y: Double) {
        if path.isEmpty { path.move(to: pt(x, y)) } else { path.addLine(to: pt(x, y)) }
    }
    public func closePath() { if !path.isEmpty { path.closeSubpath() } }
    public func bezierCurveTo(_ c1x: Double, _ c1y: Double, _ c2x: Double, _ c2y: Double, _ x: Double, _ y: Double) {
        if path.isEmpty { path.move(to: pt(c1x, c1y)) }
        path.addCurve(to: pt(x, y), control1: pt(c1x, c1y), control2: pt(c2x, c2y))
    }
    public func quadraticCurveTo(_ cx: Double, _ cy: Double, _ x: Double, _ y: Double) {
        if path.isEmpty { path.move(to: pt(cx, cy)) }
        path.addQuadCurve(to: pt(x, y), control: pt(cx, cy))
    }
    public func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) {
        path.addRect(CGRect(x: CGFloat(Float(x)), y: CGFloat(Float(y)), width: CGFloat(Float(w)), height: CGFloat(Float(h))))
    }

    private static let twoPiFloat = Float(2 * Double.pi)

    /// WebKit normalizeAngles (float math).
    private static func normalize(_ sa: inout Float, _ ea: inout Float, _ anticlockwise: Bool) {
        var ns = fmodf(sa, twoPiFloat)
        if ns < 0 { ns += twoPiFloat }
        let delta = ns - sa
        sa = ns; ea += delta
        if anticlockwise && sa - ea >= twoPiFloat { ea = sa - twoPiFloat }
        else if !anticlockwise && ea - sa >= twoPiFloat { ea = sa + twoPiFloat }
    }

    public func arc(_ x: Double, _ y: Double, _ r: Double, _ a0: Double, _ a1: Double, _ anticlockwise: Bool = false) {
        guard r >= 0 else { return }
        var sa = Float(a0), ea = Float(a1)
        let c = pt(x, y), rf = CGFloat(Float(r))
        if r == 0 { lineTo(Double(c.x) + 0, Double(c.y)); return }
        if anticlockwise && sa - ea >= Canvas.twoPiFloat {
            path.addArc(center: c, radius: rf, startAngle: CGFloat(sa), endAngle: CGFloat(sa - Canvas.twoPiFloat), clockwise: anticlockwise); return
        }
        if !anticlockwise && ea - sa >= Canvas.twoPiFloat {
            path.addArc(center: c, radius: rf, startAngle: CGFloat(sa), endAngle: CGFloat(sa + Canvas.twoPiFloat), clockwise: anticlockwise); return
        }
        Canvas.normalize(&sa, &ea, anticlockwise)
        path.addArc(center: c, radius: rf, startAngle: CGFloat(sa), endAngle: CGFloat(ea), clockwise: anticlockwise)
    }

    public func ellipse(_ x: Double, _ y: Double, _ rx: Double, _ ry: Double, _ rotation: Double, _ a0: Double, _ a1: Double, _ anticlockwise: Bool = false) {
        guard rx >= 0, ry >= 0 else { return }
        var sa = Float(a0), ea = Float(a1)
        let rot = Float(rotation)
        if anticlockwise && sa - ea >= Canvas.twoPiFloat { ea = sa - Canvas.twoPiFloat }
        else if !anticlockwise && ea - sa >= Canvas.twoPiFloat { ea = sa + Canvas.twoPiFloat }
        else { Canvas.normalize(&sa, &ea, anticlockwise) }
        let xf = Double(Float(x)), yf = Double(Float(y)), rxf = Double(Float(rx)), ryf = Double(Float(ry))
        // PathCG::addEllipse: translate · rotate(rad2deg→deg2rad) · scale, unit arc.
        let rad = (Double(rot) * 180.0 / Double.pi) * Double.pi / 180.0
        let t = CGAffineTransform.identity.translatedBy(x: xf, y: yf).rotated(by: rad).scaledBy(x: rxf, y: ryf)
        path.addArc(center: .zero, radius: 1, startAngle: CGFloat(sa), endAngle: CGFloat(ea), clockwise: anticlockwise, transform: t)
    }

    /// roundRect with one uniform radius (all frames.js uses).
    public func roundRect(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ r: Double) {
        let rect = CGRect(x: CGFloat(Float(x)), y: CGFloat(Float(y)), width: CGFloat(Float(w)), height: CGFloat(Float(h)))
        var rr = Float(r)
        // Canvas spec: scale radii down if they overflow a side.
        let scaleF = min(Float(rect.width) / (rr + rr), Float(rect.height) / (rr + rr))
        if scaleF < 1 { rr *= scaleF }
        let rc = CGFloat(rr)
        if rc * 2 <= rect.width && rc * 2 <= rect.height {
            path.addRoundedRect(in: rect, cornerWidth: rc, cornerHeight: rc)
        } else {
            path.addRect(rect)
        }
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
    }

    public func fill() { guard !path.isEmpty else { return }; ctx.addPath(path); ctx.fillPath() }
    public func stroke() { guard !path.isEmpty else { return }; ctx.addPath(path); ctx.strokePath() }
    public func clip() { ctx.addPath(path); ctx.clip() }

    public func fillRect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) {
        ctx.fill(CGRect(x: CGFloat(Float(x)), y: CGFloat(Float(y)), width: CGFloat(Float(w)), height: CGFloat(Float(h))))
    }
    public func strokeRect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) {
        ctx.stroke(CGRect(x: CGFloat(Float(x)), y: CGFloat(Float(y)), width: CGFloat(Float(w)), height: CGFloat(Float(h))))
    }

    // MARK: images

    public func makeImage() -> CGImage { ctx.makeImage()! }

    /// drawImage(src, dx, dy): whole image at its own size.
    public func drawImage(_ src: CGImage, _ dx: Double, _ dy: Double) {
        drawImage(src, 0, 0, Double(src.width), Double(src.height), dx, dy, Double(src.width), Double(src.height))
    }
    public func drawImage(_ src: Canvas, _ dx: Double, _ dy: Double) { drawImage(src.makeImage(), dx, dy) }

    /// drawImage(src, dx, dy, dw, dh).
    public func drawImage(_ src: CGImage, _ dx: Double, _ dy: Double, _ dw: Double, _ dh: Double) {
        drawImage(src, 0, 0, Double(src.width), Double(src.height), dx, dy, dw, dh)
    }

    /// drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh), as WebKit's
    /// GraphicsContextCG::drawNativeImageInternal: float rects; a source
    /// sub-rect becomes the whole image scaled so the sub-rect lands on dest,
    /// clipped to dest (interpolation "low", so never the subimage path).
    public func drawImage(_ src: CGImage, _ sx: Double, _ sy: Double, _ sw: Double, _ sh: Double,
                          _ dx: Double, _ dy: Double, _ dw: Double, _ dh: Double) {
        let s = (x: Float(sx), y: Float(sy), w: Float(sw), h: Float(sh))
        let d = (x: Float(dx), y: Float(dy), w: Float(dw), h: Float(dh))
        let imgW = Float(src.width), imgH = Float(src.height)
        let scaleX: Float = d.w / s.w, scaleY: Float = d.h / s.h
        let adj = (x: d.x - s.x * scaleX, y: d.y - s.y * scaleY, w: imgW * scaleX, h: imgH * scaleY)
        ctx.saveGState()
        if !(s.x == 0 && s.y == 0 && s.w == imgW && s.h == imgH) {
            ctx.clip(to: CGRect(x: CGFloat(d.x), y: CGFloat(d.y), width: CGFloat(d.w), height: CGFloat(d.h)))
        }
        ctx.translateBy(x: CGFloat(adj.x), y: CGFloat(adj.y + adj.h)); ctx.scaleBy(x: 1, y: -1)
        ctx.draw(src, in: CGRect(x: 0, y: 0, width: CGFloat(adj.w), height: CGFloat(adj.h)))
        ctx.restoreGState()
    }

    /// Unpremultiplied RGBA, top row first (getImageData).
    public func getImageData() -> [UInt8] {
        let n = width * height
        var out = [UInt8](repeating: 0, count: n * 4)
        let p = ctx.data!.assumingMemoryBound(to: UInt8.self)
        let bpr = ctx.bytesPerRow
        for y in 0..<height {
            for x in 0..<width {
                let s = y * bpr + x * 4, o = (y * width + x) * 4
                let a = p[s + 3]
                if a == 255 || a == 0 {
                    out[o] = p[s + 2]; out[o + 1] = p[s + 1]; out[o + 2] = p[s]
                } else {
                    // WebKit: (c * 255 + a/2) / a
                    let ai = Int(a)
                    out[o] = UInt8(min(255, (Int(p[s + 2]) * 255 + ai / 2) / ai))
                    out[o + 1] = UInt8(min(255, (Int(p[s + 1]) * 255 + ai / 2) / ai))
                    out[o + 2] = UInt8(min(255, (Int(p[s]) * 255 + ai / 2) / ai))
                }
                out[o + 3] = a
            }
        }
        return out
    }

    /// putImageData for opaque data (photo tiles).
    public func putOpaqueGray(_ g: [UInt8]) {
        let p = ctx.data!.assumingMemoryBound(to: UInt8.self)
        let bpr = ctx.bytesPerRow
        for y in 0..<height { for x in 0..<width {
            let s = y * bpr + x * 4, v = g[y * width + x]
            p[s] = v; p[s + 1] = v; p[s + 2] = v; p[s + 3] = 255
        } }
    }

    // MARK: text

    /// Lilita One TTF in the package (register it to use it in UI).
    public static let lilitaURL: URL = Bundle.module.url(forResource: "LilitaOne", withExtension: "ttf", subdirectory: "Resources")
        ?? Bundle.module.url(forResource: "LilitaOne", withExtension: "ttf")!
    private static let lilita: CGFont = CGFont(CGDataProvider(url: lilitaURL as CFURL)!)!
    /// The CTFont for Lilita at `size` (also used by the app's UI numerals).
    public static func lilitaFont(_ size: Double) -> CTFont { CTFontCreateWithGraphicsFont(lilita, CGFloat(size), nil, nil) }

    private static func stack(_ f: CanvasFont) -> [CTFont] {
        let s = CGFloat(Float(f.size))
        if f.emoji { return [CTFontCreateWithName("AppleColorEmoji" as CFString, s, nil)] }
        return [CTFontCreateWithGraphicsFont(lilita, s, nil, nil), CTFontCreateWithName("ArialRoundedMTBold" as CFString, s, nil)]
    }

    private struct Run { var font: CTFont; var glyphs: [CGGlyph]; var advances: [CGFloat] }

    /// Split into runs by which font in the stack covers each grapheme (WebKit's
    /// font cascade), then let CoreText shape each run with kerning, as WebKit does.
    private static func shape(_ s: String, _ fonts: [CTFont]) -> [Run] {
        var pieces: [(CTFont, String)] = []
        for ch in s {
            let u = Array(String(ch).utf16)
            var g = [CGGlyph](repeating: 0, count: u.count)
            let f = fonts.first { CTFontGetGlyphsForCharacters($0, u, &g, u.count) } ?? fonts[0]
            if let last = pieces.last, CFEqual(last.0, f) { pieces[pieces.count - 1].1.append(ch) } else { pieces.append((f, String(ch))) }
        }
        var runs: [Run] = []
        for (font, text) in pieces {
            let attr = NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font])
            let line = CTLineCreateWithAttributedString(attr)
            for r in CTLineGetGlyphRuns(line) as! [CTRun] {
                let n = CTRunGetGlyphCount(r)
                var gg = [CGGlyph](repeating: 0, count: n), pos = [CGPoint](repeating: .zero, count: n)
                CTRunGetGlyphs(r, CFRange(location: 0, length: n), &gg)
                CTRunGetPositions(r, CFRange(location: 0, length: n), &pos)
                let width = CGFloat(CTRunGetTypographicBounds(r, CFRange(location: 0, length: 0), nil, nil, nil))
                var adv: [CGFloat] = []
                for i in 0..<n { adv.append((i + 1 < n ? pos[i + 1].x : pos[0].x + width) - pos[i].x) }
                let rf = (CTRunGetAttributes(r) as NSDictionary)[kCTFontAttributeName] as! CTFont
                runs.append(Run(font: rf, glyphs: gg, advances: adv))
            }
        }
        return runs
    }

    public func measureText(_ s: String) -> Double {
        Double(Canvas.shape(s, Canvas.stack(text.font)).reduce(0) { $0 + $1.advances.reduce(0, +) })
    }

    public func fillText(_ s: String, _ x: Double, _ y: Double, maxWidth: Double? = nil) { drawText(s, x, y, maxWidth: maxWidth, stroke: false) }
    public func strokeText(_ s: String, _ x: Double, _ y: Double) { drawText(s, x, y, maxWidth: nil, stroke: true) }

    private func drawText(_ s: String, _ x: Double, _ y: Double, maxWidth: Double?, stroke: Bool) {
        let fonts = Canvas.stack(text.font)
        let runs = Canvas.shape(s, fonts)
        // FontCascade::width: float sum of float advances.
        let width = CGFloat(runs.reduce(Float(0)) { $0 + $1.advances.reduce(Float(0)) { $0 + Float($1) } })
        let primary = fonts[0]
        let asc = CTFontGetAscent(primary), desc = CTFontGetDescent(primary)
        let dy: CGFloat
        switch text.baseline {
        case .alphabetic: dy = 0
        case .middle:   // WebKit: integer font metrics, height / 2 − descent
            let a = Int(asc.rounded()), d = Int(desc.rounded())
            dy = CGFloat((a + d) / 2 - d)
        case .top: dy = asc
        case .bottom: dy = -desc
        }
        // CanvasRenderingContext2DBase::drawTextInternal: float location, aligned
        // by the (possibly maxWidth-clamped) width; with maxWidth, translate there
        // and squeeze horizontally around it.
        let fontWidth = Float(width)
        let useMax = maxWidth.map { Float($0) < fontWidth } ?? false
        let w: Float = useMax ? Float(maxWidth!) : fontWidth
        var lx = Float(x)
        let ly = Float(y) + Float(dy)
        switch text.align {
        case .start, .left: break
        case .center: lx -= w / 2
        case .right, .end: lx -= w
        }
        ctx.saveGState()
        var origin = CGPoint(x: CGFloat(lx), y: CGFloat(ly))
        if useMax {
            ctx.translateBy(x: CGFloat(lx), y: CGFloat(ly))
            ctx.scaleBy(x: CGFloat(fontWidth > 0 ? w / fontWidth : 0), y: 1)
            origin = .zero
        }
        ctx.setTextDrawingMode(stroke ? .stroke : .fill)
        // FontCascadeCocoa showGlyphsWithAdvances: flipped text matrix, text
        // position at the run's origin, glyph positions accumulated from advances.
        var px = origin.x
        for r in runs {
            var pos: [CGPoint] = []
            var cx: CGFloat = 0
            for a in r.advances { pos.append(CGPoint(x: cx, y: 0)); cx += CGFloat(Float(a)) }
            ctx.textMatrix = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 0)
            ctx.textPosition = CGPoint(x: px, y: origin.y)
            CTFontDrawGlyphs(r.font, r.glyphs, pos, r.glyphs.count, ctx)
            px = CGFloat(Float(px) + Float(cx))
        }
        ctx.restoreGState()
    }
}

extension Canvas {
    /// putImageData for opaque RGBA (top row first) — e.g. a camera frame.
    public func putRGBA(_ rgba: [UInt8]) {
        let p = ctx.data!.assumingMemoryBound(to: UInt8.self)
        let bpr = ctx.bytesPerRow
        for y in 0..<height { for x in 0..<width {
            let s = y * bpr + x * 4, o = (y * width + x) * 4
            p[s] = rgba[o + 2]; p[s + 1] = rgba[o + 1]; p[s + 2] = rgba[o]; p[s + 3] = 255
        } }
    }
}
