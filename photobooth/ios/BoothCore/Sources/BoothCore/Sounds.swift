// Booth sound effects, synthesized like public/sound.js (same tones), as WAV
// data for AVAudioPlayer. No microphone, no Web Audio quirks to dodge here,
// but the same little bleeps so the two booths sound alike.

import Foundation

public struct Tone: Sendable {
    public enum Wave: Sendable { case sine, square, sawtooth, triangle }
    var f: Double, dur: Double, type: Wave = .sine, vol: Double = 0.25, at: Double = 0, slide: Double? = nil
}

public enum SoundBank {
    static let rate = 22050.0

    public static let sounds: [String: [Tone]] = [
        "tick1": [Tone(f: 770, dur: 0.12, type: .square, vol: 0.12)],
        "tick2": [Tone(f: 660, dur: 0.12, type: .square, vol: 0.12)],
        "tick3": [Tone(f: 550, dur: 0.12, type: .square, vol: 0.12)],
        "tickN": [Tone(f: 440, dur: 0.12, type: .square, vol: 0.12)],
        "snap": [Tone(f: 1800, dur: 0.04, type: .square, vol: 0.2), Tone(f: 700, dur: 0.15, type: .triangle, vol: 0.25, at: 0.03, slide: 200)],
        "tap": [Tone(f: 600, dur: 0.07, vol: 0.18, slide: 900)],
        "boop": [Tone(f: 300, dur: 0.12, type: .triangle, vol: 0.2, slide: 520)],
        "whirr": (0..<10).map { i in Tone(f: 180 + Double(i % 2) * 40, dur: 0.12, type: .sawtooth, vol: 0.05, at: Double(i) * 0.13) },
        "yay": [523.0, 659, 784, 1047, 1319].enumerated().map { i, f in Tone(f: f, dur: 0.22, type: .triangle, vol: 0.2, at: Double(i) * 0.09) },
        "boo": [Tone(f: 400, dur: 0.5, vol: 0.2, slide: 180)],
    ]

    /// tones → mono 16-bit WAV.
    public static func wav(_ tones: [Tone]) -> Data {
        let end = (tones.map { $0.at + $0.dur }.max() ?? 0) + 0.02
        let n = Int((end * rate).rounded(.up))
        var pcm = [Double](repeating: 0, count: n)
        for t in tones {
            let i0 = Int(t.at * rate), len = Int(t.dur * rate)
            var phase = 0.0
            var i = 0
            while i < len && i0 + i < n {
                let k = Double(i) / Double(len)
                let f = t.slide.map { t.f * pow($0 / t.f, k) } ?? t.f
                phase += f / rate
                let p = phase.truncatingRemainder(dividingBy: 1)
                let w: Double
                switch t.type {
                case .square: w = p < 0.5 ? 1 : -1
                case .sawtooth: w = 2 * p - 1
                case .triangle: w = 1 - 4 * abs(p - 0.5)
                case .sine: w = sin(2 * .pi * p)
                }
                let env = min(1, Double(i) / (0.004 * rate)) * pow(0.001, k)
                pcm[i0 + i] += w * t.vol * env
                i += 1
            }
        }
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + n * 2)); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(UInt32(n * 2))
        for v in pcm { u16(UInt16(bitPattern: Int16(max(-1, min(1, v)) * 32767))) }
        return d
    }
}
