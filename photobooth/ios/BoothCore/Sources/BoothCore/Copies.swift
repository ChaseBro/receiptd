// How many copies to print (public/copies.js), plus small booth policies.

import Foundation

public let MIN_COPIES = 1
public let MAX_COPIES = 6   // keep in sync with MAX_COPIES in src/index.ts

/// Any value → a copy count in 1…6.
public func clampCopies(_ n: Int) -> Int { min(MAX_COPIES, max(MIN_COPIES, n)) }

/// Most faces seen in any frame of the strip, or nil when detection didn't run.
public func maxFaces(_ counts: [Int]?) -> Int? {
    guard let counts, !counts.isEmpty else { return nil }
    let ok = counts.filter { $0 >= 0 }
    return ok.isEmpty ? nil : ok.max()
}

/// Default copies: one per face, clamped; 1 if no faces or no detector.
public func defaultCopies(_ counts: [Int]?) -> Int { maxFaces(counts).map { $0 > 0 ? clampCopies($0) : 1 } ?? 1 }

/// Settings defaults (public/copies.js): copies to start with, most copies a kid can pick.
public let START_COPIES = 1
public let KID_MAX_COPIES = 3

/// The kid's limit: settings → "most copies a kid can pick", 1…MAX_COPIES.
public func kidMax(_ max: Int = KID_MAX_COPIES) -> Int { clampCopies(max) }

/// Copies on the review screen: one per face, never below "copies to start with", never above the kid max.
public func startCopies(_ counts: [Int]?, start: Int = START_COPIES, max: Int = KID_MAX_COPIES) -> Int {
    Swift.min(kidMax(max), Swift.max(clampCopies(start), defaultCopies(counts)))
}

/// Anti-mashing cooldown after printing (from photo-receipts): 1 s, growing to
/// 15 s when prints pile up within a minute.
public func cooldownSeconds(recentPrints: Int) -> Double {
    recentPrints < 2 ? 1 : min(15, 1 + Double(recentPrints - 1) * 3.5)
}

/// Head heat carried across prints: e-folding 60 s while idle (index.html headHeat).
public func headHeat(sink: Double, at t: Double, now: Double) -> Double { sink * exp(-max(0, now - t) / 60) }

/// The calibration bands A–E (thermal gains).
public let CALIBRATION_GAINS: [Double] = [0, 0.1, 0.15, 0.25, 0.4]

/// Segments for a composed strip: the QR block prints without solid-black relief.
public func stripSegments(_ L: StripLayout, gain: Double) -> [DitherSegment] {
    let main = ThermalOptions(gain: gain, bleed: 0)
    if L.qrSide > 0 {
        return [DitherSegment(y0: 0, y1: Int(L.qrY), opts: main),
                DitherSegment(y0: Int(L.qrY), y1: L.H, opts: ThermalOptions(gain: 0, bleed: 0, relief: nil))]
    }
    return [DitherSegment(y0: 0, y1: L.H, opts: main)]
}

/// Calibration strip segments: one band per gain.
public func calibrationSegments(H: Int, bandH: Int) -> [DitherSegment] {
    CALIBRATION_GAINS.enumerated().map { i, g in
        DitherSegment(y0: i == 0 ? 0 : 20 + i * bandH, y1: i == CALIBRATION_GAINS.count - 1 ? H : 20 + (i + 1) * bandH, opts: ThermalOptions(gain: g, bleed: 0))
    }
}
