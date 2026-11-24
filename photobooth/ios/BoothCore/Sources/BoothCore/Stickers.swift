// Emoji stickers for frames.js `sticker()`: the S×S art (emoji centred at
// `size` px) plus its white halo and black shadow silhouettes.
//
// These are baked from WebKit by ../parity/gen.mjs (Resources/Stickers,
// premultiplied BGRA ×3, raw deflate). Two reasons the app doesn't draw them
// live: CoreText resamples colour-emoji bitmaps ±1 grey level differently from
// WebKit, and in the web app the silhouette canvases are GPU-backed, which
// rasterizes the 16 offset draws differently from CPU CoreGraphics. With the
// baked set the strip matches the web app exactly. Unknown emoji/size pairs
// (a new theme before re-baking) fall back to drawing live.

import CoreGraphics
import Foundation

struct StickerArt { let art: CGImage, halo: CGImage, shadow: CGImage }

enum Stickers {
    private static var cache: [String: StickerArt] = [:]
    private static let lock = NSLock()

    static func art(_ emoji: String, size: Double, side S: Int) -> StickerArt {
        let hex = emoji.unicodeScalars.map { String($0.value, radix: 16) }.joined(separator: "_")
        let key = "\(hex)-\(size == size.rounded() ? String(Int(size)) : String(size))"
        lock.lock(); defer { lock.unlock() }
        if let a = cache[key] { return a }
        let a = baked(key, S) ?? live(emoji, size, S)
        cache[key] = a
        return a
    }

    /// Whether a baked sticker exists (tests: every emoji the themes use is baked).
    static func isBaked(_ emoji: String, size: Double) -> Bool {
        let hex = emoji.unicodeScalars.map { String($0.value, radix: 16) }.joined(separator: "_")
        return Bundle.module.url(forResource: "\(hex)-\(Int(size))", withExtension: "z", subdirectory: "Resources/Stickers") != nil
    }

    private static func image(_ bytes: Data, _ S: Int) -> CGImage? {
        guard let prov = CGDataProvider(data: bytes as CFData) else { return nil }
        return CGImage(width: S, height: S, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: S * 4, space: Canvas.srgb,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
                       provider: prov, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    private static func baked(_ key: String, _ S: Int) -> StickerArt? {
        let n = S * S * 4
        guard let url = Bundle.module.url(forResource: key, withExtension: "z", subdirectory: "Resources/Stickers"),
              let z = try? Data(contentsOf: url),
              let raw = try? (z as NSData).decompressed(using: .zlib) as Data, raw.count == n * 3,
              let a = image(raw.subdata(in: 0..<n), S), let h = image(raw.subdata(in: n..<(2 * n)), S),
              let s = image(raw.subdata(in: (2 * n)..<(3 * n)), S) else { return nil }
        return StickerArt(art: a, halo: h, shadow: s)
    }

    private static func live(_ emoji: String, _ size: Double, _ S: Int) -> StickerArt {
        let a = Canvas(S, S)
        a.font(.emoji(size)); a.textAlign(.center); a.textBaseline(.middle)
        a.fillText(emoji, Double(S) / 2, Double(S) / 2)
        let art = a.makeImage(), o = max(5, size * 0.09)
        func sil(_ color: CGColor, _ grow: Double) -> CGImage {
            let h = Canvas(S, S)
            for k in 0..<16 { let t = (Double.pi * 2 * Double(k)) / 16; h.drawImage(art, cos(t) * grow, sin(t) * grow) }
            h.sourceIn(); h.fillStyle(color); h.fillRect(0, 0, Double(S), Double(S))
            return h.makeImage()
        }
        return StickerArt(art: art, halo: sil(Canvas.paper, o), shadow: sil(Canvas.ink, o + 3))
    }
}
