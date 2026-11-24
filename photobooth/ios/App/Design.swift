// "Thermal Arcade" (../../DESIGN.md) in SwiftUI: a toy, not an app. Kid
// screens use only emoji, shapes and numerals; words live in accessibility
// labels and the adult settings. Everything is a sticker: thick ink outline,
// hard offset shadow, slight tilt, squish on press.

import SwiftUI
import CoreText
import BoothCore

extension Color {
    init(hex: UInt32) { self.init(red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255) }
    static let paper = Color(hex: 0xFFF4DC)
    static let ink = Color(hex: 0x1A1423)
    static let pink = Color(hex: 0xFF5DA2), sun = Color(hex: 0xFFD23F), mint = Color(hex: 0x2EE6A6)
    static let sky = Color(hex: 0x3EC1FF), grape = Color(hex: 0x9B6BFF), tomato = Color(hex: 0xFF6B4A)
    static let candy: [Color] = [.pink, .sun, .mint, .sky, .grape, .tomato]
}

/// Theme → [accent, accent-2] (index.html UI map).
let THEME_ACCENTS: [String: (Color, Color)] = [
    "stars": (.sun, .grape), "hearts": (.pink, .sun), "party": (.sky, .pink), "dino": (.mint, .sun), "space": (.grape, .sky),
    "film": (.tomato, .sun), "plain": (.sky, .mint), "turkey": (.tomato, .sun), "feast": (.sun, .tomato), "leaves": (.tomato, .grape),
    "starry": (.grape, .sun), "harvest": (.sun, .mint),
]

enum Fonts {
    /// Lilita One (bundled in BoothCore, OFL) for numerals and the ticket stub.
    static let registered: Bool = {
        CTFontManagerRegisterFontsForURL(BoothCore.Canvas.lilitaURL as CFURL, .process, nil)
        return true
    }()
    static func display(_ size: CGFloat) -> Font { _ = registered; return .custom("Lilita One", size: size) }
}

let LINE: CGFloat = 4, LINE_FAT: CGFloat = 6

/// A sticker: candy fill, ink outline, hard offset shadow, a little tilt.
struct Sticker<Content: View>: View {
    var fill: Color = .white
    var corner: CGFloat = 24
    var line: CGFloat = LINE
    var shadow: CGFloat = 6
    var tilt: Double = 0
    var pressed = false
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: corner, style: .continuous)
        content
            .background(shape.fill(fill))
            .overlay(shape.strokeBorder(Color.ink, lineWidth: line))
            .background(shape.fill(Color.ink).offset(x: pressed ? 1 : shadow, y: pressed ? 1 : shadow))
            .offset(x: pressed ? shadow - 1 : 0, y: pressed ? shadow - 1 : 0)
            .rotationEffect(.degrees(tilt))
    }
}

/// Button style: drop into the shadow when pressed (the squish), with --ease-pop.
struct StickerStyle: ButtonStyle {
    var fill: Color = .white
    var corner: CGFloat = 24
    var line: CGFloat = LINE
    var shadow: CGFloat = 6
    var tilt: Double = 0
    func makeBody(configuration: Configuration) -> some View {
        Sticker(fill: fill, corner: corner, line: line, shadow: shadow, tilt: tilt, pressed: configuration.isPressed) { configuration.label }
            .animation(.spring(response: 0.18, dampingFraction: 0.5), value: configuration.isPressed)
    }
}

/// An emoji label sized for kids (≥ 72 pt targets).
struct Emoji: View {
    let s: String
    var size: CGFloat = 40
    init(_ s: String, size: CGFloat = 40) { self.s = s; self.size = size }
    var body: some View { Text(s).font(.system(size: size)).minimumScaleFactor(0.5).lineLimit(1) }
}

/// The 1- / 3-photo pictogram (black frames on white).
struct StripIcon: View {
    let shots: Int
    var body: some View {
        VStack(spacing: 3) {
            ForEach(0..<shots, id: \.self) { _ in RoundedRectangle(cornerRadius: 2).fill(Color.ink).frame(width: 26, height: shots == 1 ? 34 : 12) }
        }
        .padding(6).background(Color.white).overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.ink, lineWidth: 3))
    }
}

/// Candy dots background, like the web booth's paper.
struct PaperBackground: View {
    var accent: Color = .sun
    var body: some View {
        Color.paper.overlay(
            SwiftUI.Canvas { ctx, size in
                let step: CGFloat = 34
                var y: CGFloat = 0, row = 0
                while y < size.height + step {
                    var x: CGFloat = row % 2 == 0 ? 0 : step / 2
                    while x < size.width + step {
                        ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 6, height: 6)), with: .color(accent.opacity(0.35)))
                        x += step
                    }
                    y += step; row += 1
                }
            }
        ).ignoresSafeArea()
    }
}
