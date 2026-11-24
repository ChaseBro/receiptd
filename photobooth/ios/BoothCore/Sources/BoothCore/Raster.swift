// Raster pipeline: port of photobooth/public/raster.js (+ dither.worker.js).
//
// Bit-exact with the web app. JavaScript does its arithmetic in Double and
// rounds to Float32 only when a value is stored in a Float32Array, so this
// port keeps every intermediate in Double and stores into [Float] at exactly
// the same points. Change both files together; `swift test` compares them
// (Tests/BoothCoreTests/RasterParityTests.swift, fixtures from ../parity).
//
// Gray convention: 0 = black, 255 = white. Bit convention: 1 = black dot.

import Foundation

public let PRINT_WIDTH = 576 // 80mm @ 203dpi

/// JS `Math.round` (ties toward +∞, exact for every Double).
@inline(__always) func jsRound(_ x: Double) -> Double {
    let f = x.rounded(.down)
    return x - f >= 0.5 ? f + 1 : f
}

/// JS `x | 0` for values well inside Int32 (truncation toward zero).
@inline(__always) func trunc32(_ x: Double) -> Int { Int(x) }

/// RGBA bytes → luminance (0..255), stored as Float32 like the JS.
public func luminance(_ rgba: UnsafeBufferPointer<UInt8>, _ w: Int, _ h: Int) -> [Float] {
    var out = [Float](repeating: 0, count: w * h)
    out.withUnsafeMutableBufferPointer { o in
        var i = 0
        for j in 0..<(w * h) {
            o[j] = Float(0.299 * Double(rgba[i]) + 0.587 * Double(rgba[i + 1]) + 0.114 * Double(rgba[i + 2]))
            i += 4
        }
    }
    return out
}

public func luminance(_ rgba: [UInt8], _ w: Int, _ h: Int) -> [Float] {
    rgba.withUnsafeBufferPointer { luminance($0, w, h) }
}

/// A face box {x, y, w, h} in tile pixels (or frame pixels before facesToTile).
public struct Box: Equatable, Codable, Sendable {
    public var x, y, w, h: Double
    public init(x: Double, y: Double, w: Double, h: Double) { self.x = x; self.y = y; self.w = w; self.h = h }
}

/// Tone-map knobs (raster.js DEFAULT_TONE).
public struct ToneOptions: Sendable {
    public var levels = 0.005, minSpan = 96.0, local = 0.35, clip = 1.6
    public var tilesX = 6, tilesY = 4
    public var mid = 0.5, face = 0.64, black = 12.0, shoulder = 0.86, white = 0.965
    public var sharpen = 0.6, trc = 1.0
    public var width = 0, height = 0
    public var faces: [Box]? = nil
    public init() {}
}

private let TRC_WANT: [Double] = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 248, 254]
private let TRC_IN: [Double] = [0, 39, 50, 65, 76, 88, 102, 115.5, 128, 140, 154, 168, 179, 190, 205, 217, 222, 224]
private let TRC_LUT: [Float] = {
    var lut = [Float](repeating: 0, count: 257)
    var k = 0
    for v in 0...254 {
        let vd = Double(v)
        while TRC_WANT[k + 1] < vd { k += 1 }
        let a = TRC_WANT[k], b = TRC_WANT[k + 1]
        lut[v] = Float(TRC_IN[k] + ((TRC_IN[k + 1] - TRC_IN[k]) * (vd - a)) / (b - a))
    }
    lut[255] = 255; lut[256] = 255
    return lut
}()

private func claheLite(_ src: UnsafeMutableBufferPointer<Float>, _ w: Int, _ h: Int, _ tilesX: Int, _ tilesY: Int,
                       _ clip: Double, _ out: UnsafeMutableBufferPointer<Float>) {
    let B = 64
    var luts = [Float](repeating: 0, count: tilesX * tilesY * B)
    var hist = [Float](repeating: 0, count: B)
    let tw = Double(w) / Double(tilesX), th = Double(h) / Double(tilesY)
    for ty in 0..<tilesY {
        for tx in 0..<tilesX {
            for b in 0..<B { hist[b] = 0 }
            let x0 = Int(jsRound(Double(tx) * tw)), x1 = Int(jsRound(Double(tx + 1) * tw))
            let y0 = Int(jsRound(Double(ty) * th)), y1 = Int(jsRound(Double(ty + 1) * th))
            if y0 < y1 && x0 < x1 {
                for y in y0..<y1 {
                    let r = y * w
                    for x in x0..<x1 { hist[trunc32(Double(src[r + x]) * (Double(B) / 256))] += 1 }
                }
            }
            let n = Double((x1 - x0) * (y1 - y0)), limit = max(1, (clip * n) / Double(B))
            var excess = 0.0
            for b in 0..<B where Double(hist[b]) > limit { excess += Double(hist[b]) - limit; hist[b] = Float(limit) }
            let add = excess / Double(B), base = (ty * tilesX + tx) * B
            var acc = 0.0
            for b in 0..<B {
                let c = Double(hist[b]) + add
                luts[base + b] = Float(((acc + c / 2) / n) * 255)
                acc += c
            }
        }
    }
    var cx0 = [Int](repeating: 0, count: w), cx1 = [Int](repeating: 0, count: w), cax = [Float](repeating: 0, count: w)
    for x in 0..<w {
        let fx = min(Double(tilesX - 1), max(0, (Double(x) + 0.5) / tw - 0.5))
        cx0[x] = Int(fx.rounded(.down)); cx1[x] = min(tilesX - 1, cx0[x] + 1); cax[x] = Float(fx - Double(cx0[x]))
    }
    let Bd = Double(B)
    for y in 0..<h {
        let fy = min(Double(tilesY - 1), max(0, (Double(y) + 0.5) / th - 0.5))
        let ty0 = Int(fy.rounded(.down)), ty1 = min(tilesY - 1, ty0 + 1), ay = fy - Double(ty0)
        let r0 = ty0 * tilesX * B, r1 = ty1 * tilesX * B
        var i = y * w
        for x in 0..<w {
            let v = max(0, Double(src[i]) * (Bd / 256) - 0.5)
            let b = v < Bd - 1 ? trunc32(v) : B - 2
            let fb = min(1, v - Double(b))
            let o00 = r0 + cx0[x] * B + b, o01 = r0 + cx1[x] * B + b, o10 = r1 + cx0[x] * B + b, o11 = r1 + cx1[x] * B + b
            let l00 = Double(luts[o00]) + (Double(luts[o00 + 1]) - Double(luts[o00])) * fb
            let l01 = Double(luts[o01]) + (Double(luts[o01 + 1]) - Double(luts[o01])) * fb
            let l10 = Double(luts[o10]) + (Double(luts[o10 + 1]) - Double(luts[o10])) * fb
            let l11 = Double(luts[o11]) + (Double(luts[o11 + 1]) - Double(luts[o11])) * fb
            let ax = Double(cax[x])
            out[i] = Float((l00 + (l01 - l00) * ax) * (1 - ay) + (l10 + (l11 - l10) * ax) * ay)
            i += 1
        }
    }
}

/// In-place unsharp mask, 5-tap binomial (σ≈1 px), clamped to floor..255.
private func unsharp(_ g: UnsafeMutableBufferPointer<Float>, _ w: Int, _ h: Int, _ amount: Double, _ floor: Double) {
    var tmp = [Float](repeating: 0, count: w * h), row = [Float](repeating: 0, count: w)
    let k = 1.0 / 16
    for y in 0..<h {
        let r = y * w
        for x in 0..<w {
            let a = r + (x > 1 ? x - 2 : 0), b = r + (x > 0 ? x - 1 : 0)
            let d = r + (x < w - 1 ? x + 1 : w - 1), e = r + (x < w - 2 ? x + 2 : w - 1)
            tmp[r + x] = Float((Double(g[a]) + 4 * Double(g[b]) + 6 * Double(g[r + x]) + 4 * Double(g[d]) + Double(g[e])) * k)
        }
    }
    for y in 0..<h {
        let a = (y > 1 ? y - 2 : 0) * w, b = (y > 0 ? y - 1 : 0) * w, r = y * w
        let d = (y < h - 1 ? y + 1 : h - 1) * w, e = (y < h - 2 ? y + 2 : h - 1) * w
        for x in 0..<w {
            row[x] = Float((Double(tmp[a + x]) + 4 * Double(tmp[b + x]) + 6 * Double(tmp[r + x]) + 4 * Double(tmp[d + x]) + Double(tmp[e + x])) * k)
        }
        for x in 0..<w {
            let v = Double(g[r + x]) + amount * (Double(g[r + x]) - Double(row[x]))
            g[r + x] = Float(v < floor ? floor : v > 255 ? 255 : v)
        }
    }
}

/// Weighted median of 0..255 values.
private func median(_ g: UnsafeMutableBufferPointer<Float>, _ weight: [UInt8]?) -> Double {
    var hist = [Double](repeating: 0, count: 256)
    var total = 0.0
    for i in 0..<g.count {
        let wt = weight.map { Double($0[i]) } ?? 1
        if wt != 0 {
            let v = g[i]
            hist[v < 0 ? 0 : v > 255 ? 255 : Int(v)] += wt
            total += wt
        }
    }
    if total == 0 { return .nan }
    var acc = 0.0
    for v in 0..<256 { acc += hist[v]; if acc >= total / 2 { return Double(v) + 0.5 } }
    return 255
}

/// Photo tone map for thermal paper (see raster.js toneMap for the steps).
public func toneMap(_ gray: [Float], _ p: ToneOptions = ToneOptions()) -> [Float] {
    let n = gray.count, w = p.width, h = p.height
    let is2D = w > 0 && h > 0 && w * h == n
    var out = [Float](repeating: 0, count: n)
    if n == 0 { return out }
    out.withUnsafeMutableBufferPointer { out in
        // 1. levels
        var hist = [Int](repeating: 0, count: 256)
        for i in 0..<n { let v = gray[i]; hist[v > 0 ? (v < 255 ? Int(v) : 255) : 0] += 1 }
        let cut = Double(n) * p.levels
        var lo = 0.0, hi = 255.0
        var acc = 0
        for v in 0..<256 { acc += hist[v]; if Double(acc) > cut { lo = Double(v); break } }
        acc = 0
        for v in stride(from: 255, through: 0, by: -1) { acc += hist[v]; if Double(acc) > cut { hi = Double(v); break } }
        let flat = hi - lo < p.minSpan
        if flat {
            let c = (hi + lo) / 2
            hi = min(255, max(hi, c + p.minSpan / 2)); lo = max(0, min(lo, hi - p.minSpan))
        }
        let k = 255 / max(1, hi - lo)
        for i in 0..<n { let v = (Double(gray[i]) - lo) * k; out[i] = Float(v > 0 ? (v < 255 ? v : 255) : 0) }

        // 2. local contrast
        if is2D && p.local > 0 && !flat {
            var c = [Float](repeating: 0, count: n)
            c.withUnsafeMutableBufferPointer { cb in claheLite(out, w, h, p.tilesX, p.tilesY, p.clip, cb) }
            for i in 0..<n { out[i] = Float(Double(out[i]) + (Double(c[i]) - Double(out[i])) * p.local) }
        }

        // 3. metering
        var weight: [UInt8]? = nil
        var target = p.mid, faced = false
        let faces = is2D ? (p.faces ?? []) : []
        if !faces.isEmpty {
            var wt = [UInt8](repeating: 0, count: n)
            var count = 0
            for f in faces where f.w > 0 && f.h > 0 {
                let x0 = max(0, Int(jsRound(f.x + f.w * 0.2))), x1 = min(w, Int(jsRound(f.x + f.w * 0.8)))
                let y0 = max(0, Int(jsRound(f.y + f.h * 0.2))), y1 = min(h, Int(jsRound(f.y + f.h * 0.8)))
                if y0 < y1 && x0 < x1 {
                    for y in y0..<y1 { for x in x0..<x1 { if wt[y * w + x] == 0 { count += 1 }; wt[y * w + x] = 1 } }
                }
            }
            if count >= 32 { target = p.face; faced = true; weight = wt }
        }
        if weight == nil && is2D {
            var wt = [UInt8](repeating: 0, count: n)
            for y in 0..<h {
                for x in 0..<w {
                    let dx = (Double(x) / Double(w) - 0.5) / 0.3, dy = (Double(y) / Double(h) - 0.45) / 0.3
                    wt[y * w + x] = dx * dx + dy * dy < 1 ? 3 : 1
                }
            }
            weight = wt
        }
        let m0 = median(out, weight)
        let med = min(0.99, max(0.01, (m0.isNaN || m0 == 0 ? 128 : m0) / 255))
        if faced && med < target {
            let inv = weight!.map { 1 &- $0 }
            let b0 = median(out, inv)
            let bg = (b0.isNaN || b0 == 0 ? 128 : b0) / 255
            target = min(target, med + max(0.15, 0.7 * (bg - med)))
        }
        let (cMin, cMax) = faced ? (0.12, 1.6) : (0.4, 2.0)
        let c = flat ? 1 : min(cMax, max(cMin, (med * (1 - target)) / (target * (1 - med))))

        // 4. exposure + toe/shoulder curve
        var curve = [Float](repeating: 0, count: 257)
        let b = p.black / 255, s = p.shoulder, top = p.white
        for v in 0...256 {
            let t0 = Double(min(255, v)) / 255
            var u = t0 / (t0 + c * (1 - t0))
            if u > s {
                let t = (u - s) / (1 - s), a = (top - s) / (1 - s)
                u = s + (1 - s) * (t + (a - 1) * t * t)
            }
            curve[v] = Float((b + (1 - b) * u) * 255)
        }
        for i in 0..<n {
            let v = Double(out[i]), j = Int(v), f = v - Double(j)
            out[i] = v >= 254.5 ? 255 : Float(Double(curve[j]) + (Double(curve[j + 1]) - Double(curve[j])) * f)
        }

        // 5. sharpen
        if is2D && p.sharpen > 0 { unsharp(out, w, h, p.sharpen, p.black) }

        // 6. printer precompensation
        if p.trc > 0 {
            for i in 0..<n {
                let v = Double(out[i]), j = Int(v), f = v - Double(j)
                let l = Double(TRC_LUT[j]) + (Double(TRC_LUT[j + 1]) - Double(TRC_LUT[j])) * f
                out[i] = Float(v + (l - v) * p.trc)
            }
        }
    }
    return out
}

/// Thermal print-head model knobs (raster.js DEFAULT_THERMAL).
public struct ThermalOptions: Sendable, Equatable {
    public var gain = 0.3, fastDecay = 0.7, slowDecay = 0.985, slowWeight = 0.6
    public var spread = 0.15, maxGain = 0.8, bleed = 0.35
    /// dither.worker.js: solid-black relief post-pass strength (0 = off) or full options.
    public var relief: ReliefOptions? = ReliefOptions()
    public init(gain: Double = 0.3, bleed: Double = 0.35, relief: ReliefOptions? = ReliefOptions()) {
        self.gain = gain; self.bleed = bleed; self.relief = relief
    }
}

/// Model-based Atkinson error diffusion. Returns 0/1 per pixel (1 = black).
public func ditherThermal(_ gray: ArraySlice<Float>, _ w: Int, _ h: Int, _ p: ThermalOptions = ThermalOptions()) -> [UInt8] {
    let n = w * h
    var want = [Float](repeating: 0, count: n), visible = [Float](repeating: 0, count: n)
    var bits = [UInt8](repeating: 0, count: n)
    let g0 = gray.startIndex
    for i in 0..<n { want[i] = Float(1 - Double(gray[g0 + i]) / 255) }
    for i in 0..<n { visible[i] = Float(min(1, 2 * (1 - Double(want[i])))) }
    var fast = [Float](repeating: 0, count: w), slow = [Float](repeating: 0, count: w), tmp = [Float](repeating: 0, count: w)
    want.withUnsafeMutableBufferPointer { want in
    bits.withUnsafeMutableBufferPointer { bits in
        @inline(__always) func add(_ x: Int, _ y: Int, _ e: Double) {
            if x >= 0 && x < w && y < h { let k = y * w + x; want[k] = Float(Double(want[k]) + e) }
        }
        func advance(_ heat: inout [Float], _ decay: Double, _ row: Int) {
            for x in 0..<w {
                let l = Double(heat[x > 0 ? x - 1 : x]), r = Double(heat[x < w - 1 ? x + 1 : x])
                tmp[x] = Float((Double(heat[x]) * (1 - 2 * p.spread) + (l + r) * p.spread) * decay + (1 - decay) * Double(bits[row + x]))
            }
            heat = tmp
        }
        for y in 0..<h {
            for x in 0..<w {
                let i = y * w + x
                let heat = (1 - p.slowWeight) * Double(fast[x]) + p.slowWeight * Double(slow[x])
                let extra = min(p.maxGain, p.gain * heat) * Double(visible[i])
                let ifFired = 1 + extra, ifNot = extra * p.bleed
                let wi = Double(want[i])
                let fired = wi > (ifFired + ifNot) / 2
                bits[i] = fired ? 1 : 0
                let e = (wi - (fired ? ifFired : ifNot)) / 8
                add(x + 1, y, e); add(x + 2, y, e)
                add(x - 1, y + 1, e); add(x, y + 1, e); add(x + 1, y + 1, e)
                add(x, y + 2, e)
            }
            if p.gain > 0 {
                advance(&fast, p.fastDecay, y * w)
                advance(&slow, p.slowDecay, y * w)
            }
        }
    }
    }
    return bits
}

/// Solid-black relief knobs (raster.js DEFAULT_RELIEF).
public struct ReliefOptions: Sendable, Equatable {
    public var strength = 1.0, keep = 0.88, edgeKeep = 0.7, ramp = 16.0, tail = 0.0
    public var heatDecay = 0.85, heatOn = 0.6
    public var sinkDecay = 0.9975, sinkOn = 0.2, sinkGain = 0.35
    public init(strength: Double = 1) { self.strength = strength }
}

@inline(__always) private func frac(_ v: Double) -> Double { v - v.rounded(.down) }
@inline(__always) private func holeRank(_ x: Int, _ y: Int) -> Double {
    frac(52.9829189 * frac(0.06711056 * Double(x) + 0.00583715 * Double(y)))
}

/// Solid-black relief post-pass. `sink` is the head-wide heat in/out.
public func relieveSolids(_ bits: [UInt8], _ w: Int, _ h: Int, _ p: ReliefOptions = ReliefOptions(), sink: inout Double) -> [UInt8] {
    var out = bits
    guard p.strength > 0 else { return out }
    var toLight = [UInt16](repeating: 0, count: w * h)
    let BIG = 65535
    for x in 0..<w {
        var d = BIG
        for y in stride(from: h - 1, through: 0, by: -1) {
            var n = 0
            for dy in -1...1 {
                let yy = y + dy
                if yy < 0 || yy >= h { continue }
                for dx in -1...1 { let xx = min(w - 1, max(0, x + dx)); n += Int(bits[yy * w + xx]) }
            }
            d = n < 5 ? 0 : min(BIG, d + 1)
            toLight[y * w + x] = UInt16(d)
        }
    }
    var heat = [Float](repeating: 0, count: w)
    let a = p.heatDecay
    var s0 = max(0, min(1, sink))
    for y in 0..<h {
        let row = y * w
        var duty = 0
        for x in 0..<w { duty += Int(bits[row + x]) }
        s0 = p.sinkDecay * s0 + (1 - p.sinkDecay) * (Double(duty) / Double(w))
        let sinkS = p.sinkGain > 0 ? min(1, max(0, (s0 - p.sinkOn) / (1 - p.sinkOn))) : 0
        let sinkKeep = 1 - p.sinkGain * sinkS
        for x in 0..<w {
            let l = Double(bits[row + (x > 0 ? x - 1 : x)]), r = Double(bits[row + (x < w - 1 ? x + 1 : x)])
            heat[x] = Float(a * Double(heat[x]) + (1 - a) * (0.25 * l + 0.5 * Double(bits[row + x]) + 0.25 * r))
        }
        for x in 0..<w {
            let i = row + x
            if bits[i] == 0 || bits[row + (x > 0 ? x - 1 : x)] == 0 || bits[row + (x < w - 1 ? x + 1 : x)] == 0 { continue }
            let s = min(1, max(0, (Double(heat[x]) - p.heatOn) / (1 - p.heatOn)))
            if s <= 0 && sinkS <= 0 { continue }
            let d = Double(min(Int(toLight[i]), h - y))
            if d <= p.tail { continue }
            let t = p.ramp > 0 ? min(1, (d - 1 - p.tail) / p.ramp) : 1
            let k = p.edgeKeep + (p.keep - p.edgeKeep) * t
            let keep = (1 - p.strength * s * (1 - k)) * (1 - p.strength * (1 - sinkKeep))
            if holeRank(x, y) >= keep { out[i] = 0 }
        }
    }
    sink = s0
    return out
}

/// 0/1 per pixel → packed rows (w/8 bytes each), MSB = leftmost.
public func packBits(_ bits: [UInt8], _ w: Int, _ h: Int) -> [UInt8] {
    let bpr = w / 8
    var out = [UInt8](repeating: 0, count: bpr * h)
    for y in 0..<h { for x in 0..<w where bits[y * w + x] != 0 { out[y * bpr + (x >> 3)] |= UInt8(0x80 >> (x & 7)) } }
    return out
}

/// One band of the strip dithered with its own options (dither.worker.js `segments`).
public struct DitherSegment: Sendable {
    public var y0: Int, y1: Int, opts: ThermalOptions
    public init(y0: Int, y1: Int, opts: ThermalOptions) { self.y0 = y0; self.y1 = y1; self.opts = opts }
}

/// dither.worker.js: error diffusion once, then one relief pass per copy, each
/// starting from the head heat the previous copy left. Returns bitmaps + end heat.
public func ditherStrip(_ gray: [Float], w: Int, h: Int, segments: [DitherSegment]? = nil,
                        copies: Int = 1, sinkStart: Double = 0) -> (bits: [[UInt8]], sink: Double) {
    let segs = segments ?? [DitherSegment(y0: 0, y1: h, opts: ThermalOptions())]
    let base = segs.map { ditherThermal(gray[($0.y0 * w)..<($0.y1 * w)], w, $0.y1 - $0.y0, $0.opts) }
    var sink = sinkStart
    var out: [[UInt8]] = []
    for _ in 0..<copies {
        var bits = [UInt8](repeating: 0, count: w * h)
        for (k, s) in segs.enumerated() {
            let b: [UInt8]
            if let r = s.opts.relief, r.strength != 0 { b = relieveSolids(base[k], w, s.y1 - s.y0, r, sink: &sink) } else { b = base[k] }
            bits.replaceSubrange((s.y0 * w)..<(s.y1 * w), with: b)
        }
        out.append(bits)
    }
    return (out, sink)
}
