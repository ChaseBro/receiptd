// Strip layouts + print art: port of photobooth/public/frames.js ("Thermal
// Arcade", ../../DESIGN.md). Byte-identical with the web app for the same
// frames, seed, ticket and date — `swift test` checks every theme against
// strips rendered by frames.js in WebKit (../parity/gen.mjs).
//
// Keep the order of rand() calls exactly as in JS. JS evaluates a call's
// arguments before running the callback inside it, so in
// `stamp(ctx, () => star(…rand()…), { fill: rand() < 0.5 })` the fill rand
// comes first.

import CoreGraphics
import Foundation

private let W = Double(PRINT_WIDTH)
private let INK = Canvas.ink, PAPER = Canvas.paper

/// xorshift32, as frames.js `rng`.
public struct Rng {
    private var s: UInt32
    public init(_ seed: Int) { let v = UInt32(truncatingIfNeeded: seed); s = v == 0 ? 1 : v }
    public mutating func next() -> Double {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5
        return Double(s) / 4294967296
    }
}

final class RandBox { var r: Rng; init(_ seed: Int) { r = Rng(seed) }; func callAsFunction() -> Double { r.next() } }

public struct Rect: Equatable, Sendable { public var x, y, w, h: Double }

public struct StripLayout: Sendable {
    public var photos: [Rect]
    public var stubY: Double
    public var qrY: Double
    public var qrSide: Int
    public var H: Int
}

// MARK: primitives

private func star(_ c: Canvas, _ cx: Double, _ cy: Double, _ r: Double, _ points: Int = 5, _ inner: Double = 0.45, _ rot: Double = 0) {
    c.beginPath()
    for i in 0..<(points * 2) {
        let a = (Double.pi * Double(i)) / Double(points) - Double.pi / 2 + rot
        let rr = i % 2 != 0 ? r * inner : r
        c.lineTo(cx + rr * cos(a), cy + rr * sin(a))
    }
    c.closePath()
}

private func heart(_ c: Canvas, _ cx: Double, _ cy: Double, _ s: Double) {
    c.beginPath()
    c.moveTo(cx, cy + s * 0.9)
    c.bezierCurveTo(cx - s * 1.4, cy - s * 0.1, cx - s * 0.6, cy - s * 1.1, cx, cy - s * 0.35)
    c.bezierCurveTo(cx + s * 0.6, cy - s * 1.1, cx + s * 1.4, cy - s * 0.1, cx, cy + s * 0.9)
    c.closePath()
}

private func stamp(_ c: Canvas, fill: Bool = true, halo: Double = 5, line: Double = 4, _ draw: () -> Void) {
    c.save()
    draw()
    c.lineJoin(.round)
    if halo != 0 { c.strokeStyle(PAPER); c.lineWidth = halo * 2 + line; c.stroke() }
    if fill { c.fillStyle(INK); c.fill() }
    else { c.fillStyle(PAPER); c.fill(); c.strokeStyle(INK); c.lineWidth = line; c.stroke() }
    c.restore()
}

/// Emoji die-cut sticker: thick white outline + hard black offset shadow.
private func sticker(_ c: Canvas, _ emoji: String, _ x: Double, _ y: Double, _ size: Double, _ angle: Double = 0) {
    let S = Int((size * 1.7).rounded(.up))
    let a = Stickers.art(emoji, size: size, side: S)
    let half = Double(S) / 2
    c.save(); c.translate(x, y); c.rotate(angle)
    c.drawImage(a.shadow, -half + 6, -half + 6)
    c.drawImage(a.halo, -half, -half)
    c.drawImage(a.art, -half, -half)
    c.restore()
}

private func sunburst(_ c: Canvas, _ cx: Double, _ cy: Double, _ box: Rect, _ n: Int = 24, _ fill: Double = 0.35) {
    c.save()
    c.beginPath(); c.rect(box.x, box.y, box.w, box.h); c.clip()
    c.fillStyle(INK)
    let R = hypot(box.w, box.h) * 1.2
    for i in stride(from: 0, to: n, by: 2) {
        let a0 = (Double.pi * 2 * Double(i)) / Double(n), a1 = a0 + (Double.pi * 4 * fill) / Double(n)
        c.beginPath(); c.moveTo(cx, cy)
        c.lineTo(cx + R * cos(a0), cy + R * sin(a0)); c.lineTo(cx + R * cos(a1), cy + R * sin(a1))
        c.closePath(); c.fill()
    }
    c.restore()
}

private func halftone(_ c: Canvas, _ box: Rect, _ step: Double = 12, _ f: (Double, Double) -> Double) {
    c.save(); c.fillStyle(INK)
    var y = box.y + step / 2, row = 0
    while y < box.y + box.h {
        var x = box.x + (row % 2 != 0 ? step / 2 : 0)
        while x < box.x + box.w {
            let r = (step / 2) * max(0, min(1, f((x - box.x) / box.w, (y - box.y) / box.h))).squareRoot()
            if r > 0.6 { c.beginPath(); c.arc(x, y, r, 0, Double.pi * 2); c.fill() }
            x += step
        }
        y += step; row += 1
    }
    c.restore()
}

private func zigzag(_ c: Canvas, _ y: Double, _ dir: Double = 1, _ tooth: Double = 18, _ depth: Double = 12) {
    c.save(); c.fillStyle(INK); c.beginPath(); c.moveTo(0, y)
    var x = 0.0
    while x <= W { c.lineTo(x + tooth / 2, y + dir * depth); c.lineTo(x + tooth, y); x += tooth }
    c.lineTo(W, y - dir * 4); c.lineTo(0, y - dir * 4); c.closePath(); c.fill(); c.restore()
}

private func checker(_ c: Canvas, _ y: Double, _ rows: Int = 2, _ sq: Double = 16) {
    c.save(); c.fillStyle(INK)
    for r in 0..<rows {
        var x = 0.0
        while x < W { if (Int(x / sq) + r) % 2 == 0 { c.fillRect(x, y + Double(r) * sq, sq, sq) }; x += sq }
    }
    c.restore()
}

private func footprint(_ c: Canvas, _ x: Double, _ y: Double, _ s: Double, _ angle: Double) {
    c.save(); c.translate(x, y); c.rotate(angle); c.fillStyle(INK)
    c.beginPath(); c.ellipse(0, 0, s * 0.55, s * 0.7, 0, 0, Double.pi * 2); c.fill()
    for dx in [-0.55, 0, 0.55] { c.beginPath(); c.ellipse(dx * s, -s * 1.0, s * 0.18, s * 0.32, dx * 0.6, 0, Double.pi * 2); c.fill() }
    c.restore()
}

private let MAPLE: [(Double, Double)] = [(0, -1), (0.13, -0.74), (0.32, -0.84), (0.27, -0.45), (0.58, -0.7), (0.55, -0.5), (0.92, -0.48),
    (0.75, -0.28), (0.82, -0.12), (0.45, -0.02), (0.52, 0.18), (0.1, 0.08), (0.05, 0.42), (0.03, 0.8)]
private func maple(_ c: Canvas, _ cx: Double, _ cy: Double, _ s: Double, _ rot: Double = 0) {
    let pts = MAPLE + MAPLE.reversed().map { (-$0.0, $0.1) }
    let co = cos(rot), n = sin(rot)
    c.beginPath()
    for (x, y) in pts { c.lineTo(cx + s * (x * co - y * n), cy + s * (x * n + y * co)) }
    c.closePath()
}

private func acorn(_ c: Canvas, _ x: Double, _ y: Double, _ s: Double, _ rot: Double = 0) {
    c.save(); c.translate(x, y); c.rotate(rot)
    c.fillStyle(PAPER); c.strokeStyle(INK); c.lineWidth = max(2, s * 0.14)
    c.beginPath(); c.ellipse(0, s * 0.25, s * 0.5, s * 0.62, 0, 0, Double.pi * 2); c.fill(); c.stroke()
    c.fillStyle(INK)
    c.beginPath(); c.ellipse(0, -s * 0.12, s * 0.62, s * 0.34, 0, Double.pi, Double.pi * 2); c.closePath(); c.fill()
    c.fillRect(-s * 0.07, -s * 0.72, s * 0.14, s * 0.3)
    c.restore()
}

private func feather(_ c: Canvas, _ cx: Double, _ cy: Double, _ len: Double, _ wid: Double, _ angle: Double, _ solid: Bool) {
    c.save(); c.translate(cx, cy); c.rotate(angle)
    c.beginPath(); c.moveTo(0, 0)
    c.bezierCurveTo(wid, len * 0.2, wid * 1.1, len * 0.8, 0, len)
    c.bezierCurveTo(-wid * 1.1, len * 0.8, -wid, len * 0.2, 0, 0)
    c.closePath()
    c.lineWidth = 4; c.strokeStyle(INK); c.fillStyle(solid ? INK : PAPER); c.fill(); c.stroke()
    c.strokeStyle(solid ? PAPER : INK); c.lineWidth = 3
    c.beginPath(); c.moveTo(0, len * 0.12); c.lineTo(0, len * 0.92); c.stroke()
    c.lineWidth = 2
    var k = 0.3
    while k < 0.9 {
        c.beginPath(); c.moveTo(0, len * k); c.lineTo(wid * 0.55, len * (k + 0.07)); c.moveTo(0, len * k); c.lineTo(-wid * 0.55, len * (k + 0.07)); c.stroke()
        k += 0.14
    }
    c.restore()
}

private func wheat(_ c: Canvas, _ x: Double, _ y: Double, _ len: Double, _ angle: Double, _ k: Double = 1) {
    c.save(); c.translate(x, y); c.rotate(angle)
    c.strokeStyle(INK); c.fillStyle(INK); c.lineWidth = 3 * k
    c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -len); c.stroke()
    for i in 0..<6 {
        let yy = -len * 0.45 - Double(i) * len * 0.09
        for side in [-1.0, 1.0] {
            c.beginPath(); c.ellipse(side * 6 * k, yy, 4.5 * k, 9 * k, side * 0.5, 0, Double.pi * 2); c.fill()
        }
    }
    c.beginPath(); c.ellipse(0, -len - 6 * k, 4 * k, 9 * k, 0, 0, Double.pi * 2); c.fill()
    c.restore()
}

private func gingham(_ c: Canvas, _ box: Rect, _ sq: Double = 24) {
    c.save()
    c.beginPath(); c.rect(box.x, box.y, box.w, box.h); c.clip()
    c.fillStyle(INK); c.strokeStyle(INK); c.lineWidth = 2.5
    var j = 0
    while Double(j) * sq < box.h {
        var i = 0
        while Double(i) * sq < box.w {
            let x = box.x + Double(i) * sq, y = box.y + Double(j) * sq, a = i % 2 == 0, b = j % 2 == 0
            if a && b { c.fillRect(x, y, sq, sq) }
            else if a || b {
                c.save(); c.beginPath(); c.rect(x, y, sq, sq); c.clip()
                c.beginPath()
                var d = -sq
                while d < sq * 2 { c.moveTo(x + d, y); c.lineTo(x + d + sq, y + sq); d += 7 }
                c.stroke(); c.restore()
            }
            i += 1
        }
        j += 1
    }
    c.restore()
}

private func forkKnife(_ c: Canvas, _ x: Double, _ y: Double, _ h: Double) {
    c.save(); c.fillStyle(INK)
    c.beginPath(); c.roundRect(x - 4, y + h * 0.35, 8, h * 0.65, 4); c.fill()
    c.beginPath(); c.roundRect(x - 13, y + h * 0.2, 26, h * 0.2, 6); c.fill()
    for dx in [-12.0, -4, 4] { c.fillRect(x + dx, y, 7, h * 0.3) }
    let kx = x + 40
    c.beginPath(); c.roundRect(kx - 5, y + h * 0.45, 10, h * 0.55, 5); c.fill()
    c.beginPath(); c.moveTo(kx - 6, y + h * 0.48); c.lineTo(kx - 6, y + h * 0.05); c.quadraticCurveTo(kx + 10, y + h * 0.1, kx + 7, y + h * 0.48); c.closePath(); c.fill()
    c.restore()
}

private func scatter(_ rand: RandBox, _ n: Int, _ boxes: [Rect], _ fn: (Double, Double, RandBox) -> Void) {
    for _ in 0..<n {
        let b = boxes[Int((rand() * Double(boxes.count)).rounded(.down))]
        let x = b.x + rand() * b.w
        let y = b.y + rand() * b.h
        fn(x, y, rand)
    }
}

private func margins(_ L: StripLayout) -> [Rect] {
    var boxes: [Rect] = []
    for p in L.photos {
        boxes.append(Rect(x: 6, y: p.y, w: p.x - 16, h: p.h))
        boxes.append(Rect(x: p.x + p.w + 16, y: p.y, w: W - p.x - p.w - 22, h: p.h))
    }
    return boxes.filter { $0.w > 8 && $0.h > 8 }
}

// MARK: themes

public struct Theme {
    public let key: String, icon: String
    let margin: Double, top: Double, gap: Double
    let bg: ((Canvas, StripLayout, RandBox) -> Void)?
    let fg: (Canvas, StripLayout, RandBox) -> Void
}

/// Kid picker order, as `Object.keys(THEMES)` in frames.js.
public let THEME_ORDER = ["film", "stars", "hearts", "party", "dino", "space", "turkey", "feast", "leaves", "starry", "harvest", "plain"]

private func pi(_ k: Double = 1) -> Double { Double.pi * k }

public let THEMES: [String: Theme] = [
    "film": Theme(key: "film", icon: "🎞️", margin: 52, top: 52, gap: 42, bg: { c, L, _ in
        c.fillStyle(INK)
        c.fillRect(0, 0, 38, L.stubY); c.fillRect(W - 38, 0, 38, L.stubY)
        c.fillStyle(PAPER)
        var y = 14.0
        while y < L.stubY - 24 { c.beginPath(); c.roundRect(10, y, 18, 24, 5); c.roundRect(W - 28, y, 18, 24, 5); c.fill(); y += 38 }
    }, fg: { c, L, _ in
        c.save(); c.fillStyle(INK); c.font(.display(22)); c.textAlign(.center)
        for (i, p) in L.photos.enumerated() {
            c.save(); c.translate(W / 2, p.y - 8); c.fillText("▸ \(String(format: "%02d", i + 1))A", 0, 0); c.restore()
        }
        c.restore()
    }),

    "stars": Theme(key: "stars", icon: "⭐", margin: 48, top: 168, gap: 36, bg: { c, _, _ in
        sunburst(c, W / 2, 96, Rect(x: 0, y: 0, w: W, h: 150), 28)
        c.save(); c.fillStyle(PAPER); c.beginPath(); c.arc(W / 2, 96, 74, 0, pi(2)); c.fill(); c.restore()
    }, fg: { c, L, rand in
        stamp(c, fill: true, halo: 0) { star(c, W / 2, 96, 62) }
        stamp(c, fill: false, halo: 0, line: 5) { star(c, W / 2, 100, 26) }
        for p in L.photos {
            let (cx, cy) = rand() < 0.5 ? (p.x + 4, p.y + 4) : (p.x + p.w - 4, p.y + p.h - 4)
            let fill = rand() < 0.5
            stamp(c, fill: fill) { let r = 30 + rand() * 12; star(c, cx, cy, r, 5, 0.45, rand()) }
        }
        scatter(rand, 30, margins(L)) { x, y, r in
            let fill = r() < 0.7
            stamp(c, fill: fill, halo: 0, line: 2) { let rr = 5 + r() * 8; let pts = r() < 0.3 ? 4 : 5; star(c, x, y, rr, pts, 0.42, r()) }
        }
    }),

    "hearts": Theme(key: "hearts", icon: "💖", margin: 48, top: 150, gap: 36, bg: { c, _, _ in
        c.save(); c.fillStyle(INK)
        var x = 0.0
        while x < W + 36 { c.beginPath(); c.arc(x, 18, 18, 0, pi()); c.fill(); x += 36 }
        c.restore()
        halftone(c, Rect(x: 0, y: 30, w: W, h: 100), 11) { u, v in 0.5 * (1 - v) * (0.6 + 0.4 * sin(u * 12)) }
    }, fg: { c, L, rand in
        stamp(c, fill: true, halo: 8) { heart(c, W / 2, 84, 52) }
        stamp(c, fill: false, halo: 6) { heart(c, W / 2 - 120, 92, 28) }
        stamp(c, fill: false, halo: 6) { heart(c, W / 2 + 120, 92, 28) }
        for p in L.photos { stamp(c) { heart(c, p.x + p.w - 12, p.y + 14, 26 + rand() * 10) } }
        scatter(rand, 24, margins(L)) { x, y, r in
            let fill = r() < 0.6
            stamp(c, fill: fill, halo: 0, line: 2) { heart(c, x, y, 5 + r() * 7) }
        }
    }),

    "party": Theme(key: "party", icon: "🎉", margin: 48, top: 160, gap: 36, bg: { c, _, _ in
        halftone(c, Rect(x: 0, y: 70, w: W, h: 80), 10) { _, v in 0.55 * (1 - v) }
    }, fg: { c, L, rand in
        c.save(); c.strokeStyle(INK); c.lineWidth = 4
        c.beginPath(); c.moveTo(0, 26); c.quadraticCurveTo(W / 2, 92, W, 26); c.stroke()
        for i in 0..<9 {
            let t = (Double(i) + 0.5) / 9, x = t * W, y = (1 - t) * (1 - t) * 26 + 2 * (1 - t) * t * 92 + t * t * 26
            c.beginPath(); c.moveTo(x - 26, y); c.lineTo(x + 26, y); c.lineTo(x, y + 58); c.closePath()
            c.fillStyle(i % 2 != 0 ? PAPER : INK); c.fill(); c.stroke()
            if i % 2 != 0 { c.fillStyle(INK); c.beginPath(); c.arc(x, y + 18, 7, 0, pi(2)); c.fill() }
        }
        c.restore()
        scatter(rand, 70, margins(L)) { x, y, r in
            c.save(); c.translate(x, y); c.rotate(r() * Double.pi); c.fillStyle(INK); c.strokeStyle(INK); c.lineWidth = 3
            let k = r()
            if k < 0.35 { c.fillRect(-8, -3, 16, 6) }
            else if k < 0.6 { c.beginPath(); c.arc(0, 0, 4.5, 0, pi(2)); c.fill() }
            else if k < 0.8 { c.beginPath(); c.moveTo(-9, 0); c.quadraticCurveTo(-4, -8, 0, 0); c.quadraticCurveTo(4, 8, 9, 0); c.stroke() }
            else { c.beginPath(); c.moveTo(0, -6); c.lineTo(6, 5); c.lineTo(-6, 5); c.closePath(); c.fill() }
            c.restore()
        }
        for (i, p) in L.photos.enumerated() {
            sticker(c, ["🎈", "🥳", "🎂", "🎁"][i % 4], i % 2 != 0 ? p.x + 20 : p.x + p.w - 20, p.y + p.h - 16, 74, (rand() - 0.5) * 0.6)
        }
    }),

    "dino": Theme(key: "dino", icon: "🦖", margin: 44, top: 150, gap: 40, bg: { c, L, rand in
        var y = 30.0, i = 0
        while y < L.stubY - 40 {
            footprint(c, i % 2 != 0 ? 22 : 30, y, 9, -0.2 + rand() * 0.4)
            footprint(c, i % 2 != 0 ? W - 30 : W - 22, y + 27, 9, -0.2 + rand() * 0.4)
            y += 54; i += 1
        }
    }, fg: { c, L, rand in
        c.save(); c.fillStyle(INK)
        c.beginPath(); c.moveTo(W / 2 - 110, 136); c.lineTo(W / 2 - 30, 52); c.lineTo(W / 2 + 30, 52); c.lineTo(W / 2 + 110, 136); c.closePath(); c.fill()
        c.fillStyle(PAPER); c.strokeStyle(INK); c.lineWidth = 4
        for (dx, dy, r) in [(-18.0, 36.0, 18.0), (8, 22, 22), (34, 8, 16)] { c.beginPath(); c.arc(W / 2 + dx, dy, r, 0, pi(2)); c.fill(); c.stroke() }
        c.restore()
        sticker(c, "🦕", 100, 92, 96, -0.12)
        sticker(c, "🦖", W - 100, 92, 96, 0.12)
        for (i, p) in L.photos.enumerated() {
            sticker(c, ["🦖", "🦕", "🥚", "🌋"][i % 4], i % 2 != 0 ? p.x + 26 : p.x + p.w - 26, p.y + p.h - 18, 70, (rand() - 0.5) * 0.5)
        }
    }),

    "space": Theme(key: "space", icon: "🚀", margin: 48, top: 160, gap: 36, bg: { c, L, rand in
        c.save(); c.fillStyle(INK)
        for _ in 0..<220 { let x = rand() * W, y = rand() * L.stubY; c.beginPath(); c.arc(x, y, 0.8 + rand() * 2.4, 0, pi(2)); c.fill() }
        c.strokeStyle(INK); c.lineWidth = 3; c.setLineDash([10, 9])
        for p in L.photos { c.beginPath(); c.ellipse(W / 2, p.y + p.h / 2, W / 2 - 8, p.h / 2 + 34, -0.18, 0, pi(2)); c.stroke() }
        c.restore()
    }, fg: { c, L, rand in
        c.save(); c.translate(124, 86); c.rotate(-0.35)
        c.fillStyle(PAPER); c.strokeStyle(INK); c.lineWidth = 5
        c.beginPath(); c.arc(0, 0, 46, 0, pi(2)); c.fill(); c.stroke()
        c.save(); c.beginPath(); c.arc(0, 0, 44, 0, pi(2)); c.clip()
        c.fillStyle(INK)
        var k = -40.0
        while k < 50 { c.fillRect(-50, k, 100, 6); k += 16 }
        c.restore()
        c.beginPath(); c.ellipse(0, 0, 82, 18, 0, 0.15 * Double.pi, 0.85 * Double.pi + Double.pi); c.lineWidth = 8; c.stroke()
        c.restore()
        stamp(c, halo: 0) { star(c, W / 2 + 30, 64, 22, 4, 0.3) }
        sticker(c, "🚀", W - 112, 84, 100, 0.65)
        for (i, p) in L.photos.enumerated() {
            sticker(c, ["👽", "🛸", "🌙", "🪐"][i % 4], p.x + p.w - 20, p.y + 20, 66, (rand() - 0.5) * 0.5)
        }
    }),

    "turkey": Theme(key: "turkey", icon: "🦃", margin: 48, top: 186, gap: 36, bg: { c, _, _ in
        c.save(); c.beginPath(); c.rect(0, 0, W, 172); c.clip()
        for i in 0..<11 {
            let a = Double.pi / 2 + (Double.pi * Double(i - 5)) / 6.2
            feather(c, W / 2, 150, 140, 30, a + Double.pi, i % 2 == 0)
        }
        c.restore()
    }, fg: { c, L, rand in
        c.save(); c.fillStyle(PAPER); c.strokeStyle(INK); c.lineWidth = 6
        c.beginPath(); c.arc(W / 2, 128, 46, 0, pi(2)); c.fill(); c.stroke(); c.restore()
        sticker(c, "🦃", W / 2, 120, 78, 0)
        for (i, p) in L.photos.enumerated() {
            sticker(c, ["🦃", "🥧", "🌽", "🍗"][i % 4], i % 2 != 0 ? p.x + 22 : p.x + p.w - 22, p.y + p.h - 16, 70, (rand() - 0.5) * 0.5)
        }
        scatter(rand, 16, margins(L)) { x, y, r in
            c.save(); c.translate(x, y); c.rotate(r() * Double.pi * 2); c.fillStyle(INK)
            c.beginPath(); c.ellipse(0, 0, 4, 11, 0, 0, pi(2)); c.fill(); c.restore()
        }
    }),

    "feast": Theme(key: "feast", icon: "🥧", margin: 48, top: 176, gap: 36, bg: { c, _, _ in
        gingham(c, Rect(x: 0, y: 0, w: W, h: 150), 24)
    }, fg: { c, L, rand in
        c.save(); c.fillStyle(PAPER); c.strokeStyle(INK)
        c.lineWidth = 14; c.beginPath(); c.arc(W / 2, 82, 70, 0, pi(2)); c.stroke()
        c.lineWidth = 0; c.fill()
        c.lineWidth = 5; c.beginPath(); c.arc(W / 2, 82, 64, 0, pi(2)); c.stroke()
        c.lineWidth = 2; c.beginPath(); c.arc(W / 2, 82, 50, 0, pi(2)); c.stroke()
        c.restore()
        sticker(c, "🥧", W / 2, 82, 70, 0)
        for fx in [W / 2 - 160, W / 2 + 112] {
            c.save(); c.fillStyle(PAPER); c.beginPath(); c.roundRect(fx - 24, 18, 88, 128, 16); c.fill(); c.restore()
            forkKnife(c, fx, 26, 112)
        }
        for (i, p) in L.photos.enumerated() {
            sticker(c, ["🍗", "🌽", "🥧", "🍠"][i % 4], i % 2 != 0 ? p.x + 22 : p.x + p.w - 22, p.y + p.h - 16, 72, (rand() - 0.5) * 0.5)
        }
        scatter(rand, 26, margins(L)) { x, y, r in c.save(); c.fillStyle(INK); c.beginPath(); c.arc(x, y, 2 + r() * 3, 0, pi(2)); c.fill(); c.restore() }
    }),

    "leaves": Theme(key: "leaves", icon: "🍂", margin: 48, top: 166, gap: 38, bg: { c, _, rand in
        c.save(); c.strokeStyle(INK); c.lineCap(.round); c.lineWidth = 9
        c.beginPath(); c.moveTo(-10, 34); c.bezierCurveTo(W * 0.3, 70, W * 0.6, 10, W + 10, 52); c.stroke()
        c.restore()
        for i in 0..<7 {
            let x = 40 + Double(i) * ((W - 80) / 6), y = 74 + Double(i % 2) * 34
            stamp(c, fill: i % 2 == 0, halo: 4, line: 4) { let s = 30 + rand() * 8; maple(c, x, y, s, (rand() - 0.5) * 0.9) }
        }
    }, fg: { c, L, rand in
        for p in L.photos {
            let (cx, cy) = rand() < 0.5 ? (p.x + 8, p.y + 10) : (p.x + p.w - 8, p.y + p.h - 10)
            let fill = rand() < 0.6
            stamp(c, fill: fill, halo: 6) { let s = 34 + rand() * 10; maple(c, cx, cy, s, (rand() - 0.5) * 1.4) }
        }
        scatter(rand, 26, margins(L)) { x, y, r in
            if r() < 0.25 { let s = 9 + r() * 4; acorn(c, x, y, s, r() - 0.5) }
            else { let fill = r() < 0.7; stamp(c, fill: fill, halo: 0, line: 2) { let s = 7 + r() * 7; maple(c, x, y, s, r() * 6) } }
        }
        for (i, p) in L.photos.enumerated() {
            sticker(c, ["🍁", "🐿️", "🍂", "🌰"][i % 4], i % 2 != 0 ? p.x + p.w - 22 : p.x + 22, p.y + p.h - 16, 66, (rand() - 0.5) * 0.5)
        }
    }),

    "starry": Theme(key: "starry", icon: "🌟", margin: 48, top: 176, gap: 36, bg: { c, _, rand in
        c.save(); c.fillStyle(INK); c.beginPath(); c.moveTo(0, 0); c.lineTo(W, 0); c.lineTo(W, 118)
        var x = W
        while x >= 0 { c.lineTo(x, 132 + 12 * sin(x / 70) + 6 * sin(x / 23)); x -= 8 }
        c.closePath(); c.fill()
        c.fillStyle(PAPER)
        for _ in 0..<46 { let x = rand() * W, y = 16 + rand() * 96; c.beginPath(); c.arc(x, y, 0.8 + rand() * 1.8, 0, pi(2)); c.fill() }
        for _ in 0..<6 {
            let sx = 30 + rand() * (W - 220), sy = 24 + rand() * 80, sr = 6 + rand() * 6
            star(c, sx, sy, sr, 5, 0.42, rand()); c.fill()
        }
        c.beginPath(); c.arc(W - 110, 66, 46, 0, pi(2)); c.fill()
        c.strokeStyle(INK); c.lineWidth = 3
        for (dx, dy, r) in [(-14.0, -12.0, 9.0), (16, 8, 12), (-8, 20, 6), (20, -20, 5)] { c.beginPath(); c.arc(W - 110 + dx, 66 + dy, r, 0, pi(2)); c.stroke() }
        c.restore()
    }, fg: { c, L, rand in
        sticker(c, "🦉", 96, 80, 72, -0.1)
        for p in L.photos {
            let (cx, cy) = rand() < 0.5 ? (p.x + 4, p.y + 4) : (p.x + p.w - 4, p.y + p.h - 4)
            let fill = rand() < 0.5
            stamp(c, fill: fill) { let r = 28 + rand() * 12; star(c, cx, cy, r, 5, 0.45, rand()) }
        }
        scatter(rand, 30, margins(L)) { x, y, r in
            let fill = r() < 0.7
            stamp(c, fill: fill, halo: 0, line: 2) { let rr = 4 + r() * 7; let pts = r() < 0.3 ? 4 : 5; star(c, x, y, rr, pts, 0.42, r()) }
        }
        for (i, p) in L.photos.enumerated() {
            sticker(c, ["🦃", "🌟", "🥧", "🌙"][i % 4], i % 2 != 0 ? p.x + 22 : p.x + p.w - 22, p.y + p.h - 16, 64, (rand() - 0.5) * 0.5)
        }
    }),

    "harvest": Theme(key: "harvest", icon: "🌽", margin: 50, top: 176, gap: 36, bg: { c, _, _ in
        halftone(c, Rect(x: 0, y: 14, w: W, h: 140), 11) { u, v in 0.5 * (1 - v) * (0.4 + 0.6 * abs(u - 0.5) * 2) }
    }, fg: { c, L, rand in
        for (x, dir) in [(96.0, 1.0), (W - 96, -1.0)] {
            c.save(); c.fillStyle(PAPER); c.beginPath(); c.ellipse(x, 92, 70, 66, 0, 0, pi(2)); c.fill(); c.restore()
            for a in [-0.45, -0.15, 0.15, 0.45] { wheat(c, x + dir * 4, 150, 118, a, 1) }
            c.save(); c.fillStyle(INK); c.beginPath(); c.roundRect(x - 30, 112, 60, 14, 7); c.fill(); c.restore()
        }
        sticker(c, "🌽", W / 2, 86, 92, 0.25)
        for p in L.photos {
            wheat(c, 24, p.y + p.h - 4, p.h * 0.55, 0.05, 0.7)
            wheat(c, W - 24, p.y + p.h * 0.6, p.h * 0.45, -0.05, 0.7)
        }
        for (i, p) in L.photos.enumerated() {
            sticker(c, ["🎃", "🍎", "🌽", "🍇"][i % 4], i % 2 != 0 ? p.x + 22 : p.x + p.w - 22, p.y + p.h - 16, 68, (rand() - 0.5) * 0.5)
        }
    }),

    "plain": Theme(key: "plain", icon: "📷", margin: 40, top: 70, gap: 30, bg: { c, _, _ in checker(c, 22, 2, 16) }, fg: { _, _, _ in }),
]

// MARK: layout + compose

private func slotAspect(_ w: Double, _ h: Double) -> Double { w >= h ? 4.0 / 3 : 4.0 / 5 }
private let OFFSET = 10.0, STUB = 150.0, QR_MODULE = 5, QR_PAD = 30

public func layout(_ theme: String, frames: [(w: Int, h: Int)], footer: String = "", qr: String = "") -> StripLayout {
    let t = THEMES[theme] ?? THEMES["plain"]!
    let pw = W - 2 * t.margin - OFFSET
    var y = t.top
    let photos = frames.map { f -> Rect in
        let h = jsRound(pw / slotAspect(Double(f.w), Double(f.h)))
        let r = Rect(x: t.margin, y: y, w: pw, h: h)
        y += h + t.gap
        return r
    }
    let stubY = y - t.gap + 34
    let qrY = stubY + STUB + (footer.isEmpty ? 0 : 40)
    let qrSz = qr.isEmpty ? 0 : QR.side(qr, module: QR_MODULE)
    return StripLayout(photos: photos, stubY: stubY, qrY: qrY, qrSide: qrSz, H: Int(qrY) + (qr.isEmpty ? 0 : qrSz + QR_PAD))
}

public struct Crop { public var sx, sy, sw, sh: Double }

public func coverCrop(_ fw: Double, _ fh: Double, _ w: Double, _ h: Double) -> Crop {
    let sa = fw / fh, da = w / h
    var sw = fw, sh = fh
    if sa > da { sw = sh * da } else { sh = sw / da }
    return Crop(sx: (fw - sw) / 2, sy: (fh - sh) / 2, sw: sw, sh: sh)
}

public func facesToTile(_ faces: [Box]?, _ crop: Crop, _ w: Double, _ h: Double) -> [Box] {
    guard let faces else { return [] }
    let k = w / crop.sw
    var out: [Box] = []
    for f in faces where f.w > 0 && f.h > 0 {
        let x0 = (f.x - crop.sx) * k, y0 = (f.y - crop.sy) * k
        let x1 = x0 + f.w * k, y1 = y0 + f.h * k
        let cx0 = max(0, x0), cy0 = max(0, y0), cx1 = min(w, x1), cy1 = min(h, y1)
        if cx1 <= cx0 || cy1 <= cy0 { continue }
        if (cx1 - cx0) * (cy1 - cy0) < 0.3 * (x1 - x0) * (y1 - y0) { continue }
        out.append(Box(x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0))
    }
    return out
}

/// Uint8ClampedArray store: clamp, round half to even.
@inline(__always) func clampByte(_ v: Float) -> UInt8 {
    let x = Double(v)
    if !(x > 0) { return 0 }
    if x >= 255 { return 255 }
    let f = x.rounded(.down)
    if f + 0.5 < x { return UInt8(f + 1) }
    if x < f + 0.5 { return UInt8(f) }
    return UInt8(f).isMultiple(of: 2) ? UInt8(f) : UInt8(f + 1)
}

/// Cover-crop + tone-map a frame into a w×h tile.
public func photoTile(_ frame: CGImage, _ w: Int, _ h: Int, faces: [Box]?) -> Canvas {
    let c = Canvas(w, h)
    let crop = coverCrop(Double(frame.width), Double(frame.height), Double(w), Double(h))
    c.drawImage(frame, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, Double(w), Double(h))
    var opts = ToneOptions(); opts.width = w; opts.height = h
    opts.faces = facesToTile(faces, crop, Double(w), Double(h))
    let g = toneMap(luminance(c.getImageData(), w, h), opts)
    c.putOpaqueGray(g.map(clampByte))
    return c
}

/// The ticket stub's date text: "NOV 26 · 5:39 PM" and "2026", as en-US
/// `toLocaleDateString` / `toLocaleTimeString` print them in WebKit.
public struct StubDate: Sendable, Equatable {
    public var label: String, year: String
    public init(label: String, year: String) { self.label = label; self.year = year }
    public init(_ date: Date, timeZone: TimeZone = .current) {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US"); f.timeZone = timeZone
        f.setLocalizedDateFormatFromTemplate("MMMd")
        let d = f.string(from: date).uppercased()
        f.setLocalizedDateFormatFromTemplate("hmm")
        let t = f.string(from: date).uppercased()
        let fix = { (s: String) in s.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ") }
        label = fix("\(d) · \(t)")
        f.dateFormat = "yyyy"
        year = f.string(from: date)
    }
}

private func ticketStub(_ c: Canvas, _ L: StripLayout, ticket: Int, date: StubDate, footer: String) {
    let y = L.stubY
    c.save()
    c.strokeStyle(INK); c.lineWidth = 3; c.setLineDash([12, 10])
    c.beginPath(); c.moveTo(30, y); c.lineTo(W - 10, y); c.stroke(); c.setLineDash([])
    c.fillStyle(INK)
    c.font(.emoji(30)); c.textBaseline(.middle); c.fillText("✂", 0, y)
    for x in [0, W] { c.beginPath(); c.arc(x, y + 64, 18, 0, pi(2)); c.fill() }
    c.textBaseline(.middle)
    c.font(.display(34))
    let label = date.label, tw = c.measureText(label) + 40
    c.beginPath(); c.roundRect(34, y + 38, tw, 52, 26); c.fill()
    c.fillStyle(PAPER); c.fillText(label, 54, y + 66)
    c.fillStyle(INK); c.font(.display(20))
    c.fillText(date.year, 54, y + 112)
    c.font(.display(76)); c.textAlign(.right)
    let num = "№" + String(format: "%03d", ticket)
    c.fillText(num, W - 22, y + 76)
    c.lineWidth = 3; c.strokeStyle(INK); c.fillStyle(PAPER)
    c.fillText(num, W - 28, y + 70); c.strokeText(num, W - 28, y + 70)
    if !footer.isEmpty {
        c.fillStyle(INK); c.textAlign(.center); c.font(.display(30))
        c.fillText(footer, W / 2, y + 152, maxWidth: W - 60)
    }
    c.restore()
}

private func drawQR(_ c: Canvas, _ text: String, _ x: Double, _ y: Double, _ module: Int = 5, _ quiet: Int = 4) {
    let m = QR.matrix(text)
    let side = Double((m.n + 2 * quiet) * module), md = Double(module)
    c.save()
    c.fillStyle(PAPER); c.fillRect(x, y, side, side)
    c.fillStyle(INK)
    for r in 0..<m.n { for col in 0..<m.n where m.dark(r, col) {
        c.fillRect(x + Double(col + quiet) * md, y + Double(r + quiet) * md, md, md)
    } }
    c.restore()
}

private func qrBlock(_ c: Canvas, _ L: StripLayout, _ url: String) {
    let side = Double(L.qrSide), x = W - side - 26, y = L.qrY + 6
    c.save()
    c.fillStyle(INK); c.fillRect(x + 8, y + 8, side, side)
    drawQR(c, url, x, y, QR_MODULE)
    c.strokeStyle(INK); c.lineWidth = 5; c.strokeRect(x - 2, y - 2, side + 4, side + 4)
    let ay = y + side / 2, ax0 = 200.0, ax1 = x - 26
    c.lineWidth = 10; c.lineCap(.round); c.setLineDash([2, 18])
    c.beginPath(); c.moveTo(ax0, ay); c.lineTo(ax1 - 16, ay); c.stroke(); c.setLineDash([])
    c.fillStyle(INK); c.beginPath(); c.moveTo(ax1, ay); c.lineTo(ax1 - 30, ay - 22); c.lineTo(ax1 - 30, ay + 22); c.closePath(); c.fill()
    c.restore()
    sticker(c, "📲", 110, ay, 96, -0.12)
}

public struct ComposeOptions {
    public var theme = "stars", seed = 1, footer = "", ticket = 1
    public var date = StubDate(Date())
    /// Per frame: face boxes in that frame's pixels (nil/empty → centre metering).
    public var faces: [[Box]]? = nil
    public var qr = ""
    public init() {}
}

/// Build the full grayscale strip. frames: upright images. Returns canvas + layout.
public func compose(_ frames: [CGImage], _ o: ComposeOptions) -> (canvas: Canvas, layout: StripLayout) {
    let t = THEMES[o.theme] ?? THEMES["plain"]!
    let L = layout(o.theme, frames: frames.map { ($0.width, $0.height) }, footer: o.footer, qr: o.qr)
    let rand = RandBox(o.seed)
    let c = Canvas(PRINT_WIDTH, L.H)
    c.fillStyle(PAPER); c.fillRect(0, 0, W, Double(L.H))
    t.bg?(c, L, rand)
    for (i, p) in L.photos.enumerated() {
        let faces = (o.faces?.count ?? 0) > i ? o.faces![i] : nil
        let tile = photoTile(frames[i], Int(p.w), Int(p.h), faces: faces)
        let tilt = ((rand() - 0.5) * 2 * (o.theme == "film" ? 0 : 1.6) * Double.pi) / 180
        c.save()
        c.translate(p.x + p.w / 2, p.y + p.h / 2); c.rotate(tilt)
        c.fillStyle(INK); c.fillRect(-p.w / 2 + OFFSET, -p.h / 2 + OFFSET, p.w, p.h)
        c.fillStyle(PAPER); c.fillRect(-p.w / 2 - 6, -p.h / 2 - 6, p.w + 12, p.h + 12)
        c.drawImage(tile.makeImage(), -p.w / 2, -p.h / 2)
        c.strokeStyle(INK); c.lineWidth = 6; c.strokeRect(-p.w / 2 - 3, -p.h / 2 - 3, p.w + 6, p.h + 6)
        c.restore()
    }
    t.fg(c, L, rand)
    zigzag(c, 0, 1, 18, 10)
    zigzag(c, Double(L.H), -1, 18, 10)
    ticketStub(c, L, ticket: o.ticket, date: o.date, footer: o.footer)
    if !o.qr.isEmpty { qrBlock(c, L, o.qr) }
    return (c, L)
}

/// Calibration strip: one band per thermal gain, black block over greys.
public func calibrationGray(_ gains: [Double]) -> (gray: [Float], H: Int, bandH: Int) {
    let bandH = 300, H = bandH * gains.count + 40
    let c = Canvas(PRINT_WIDTH, H)
    c.fillStyle(PAPER); c.fillRect(0, 0, W, Double(H))
    c.textBaseline(.middle)
    for (i, _) in gains.enumerated() {
        let y = Double(20 + i * bandH)
        c.fillStyle(INK); c.font(.display(40))
        c.fillText(String(UnicodeScalar(UInt8(65 + i))), 12, y + 50)
        c.fillRect(60, y, 320, 100)
        c.fillStyle(Canvas.gray(191)); c.fillRect(60, y + 100, W - 80, 60)
        c.fillStyle(Canvas.gray(128)); c.fillRect(60, y + 160, W - 80, 60)
        // linear gradient paper → ink across x 60…W-20
        let grad = CGGradient(colorsSpace: Canvas.srgb, colors: [PAPER, INK] as CFArray, locations: [0, 1])!
        c.ctx.saveGState()
        c.ctx.clip(to: CGRect(x: 60, y: y + 220, width: W - 80, height: 40))
        c.ctx.drawLinearGradient(grad, start: CGPoint(x: 60, y: 0), end: CGPoint(x: W - 20, y: 0), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        c.ctx.restoreGState()
    }
    return (luminance(c.getImageData(), PRINT_WIDTH, H), H, bandH)
}
