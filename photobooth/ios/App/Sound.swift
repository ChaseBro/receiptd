// Bleeps (same tones as the web booth's sound.js), played with AVAudioPlayer
// under the ambient category: no microphone, respects the silent switch off.

import AVFoundation
import UIKit
import BoothCore

@MainActor final class Sfx {
    static let shared = Sfx()
    var enabled = true
    private var players: [String: [AVAudioPlayer]] = [:]

    private init() {
        try? AVAudioSession.sharedInstance().setCategory(.ambient, options: [.mixWithOthers])
        for (name, tones) in SoundBank.sounds {
            let data = SoundBank.wav(tones)
            players[name] = (0..<2).compactMap { _ in let p = try? AVAudioPlayer(data: data); p?.prepareToPlay(); return p }
        }
    }

    func play(_ name: String) {
        guard enabled, let pool = players[name] else { return }
        let p = pool.first { !$0.isPlaying } ?? pool[0]
        p.currentTime = 0; p.play()
    }
    func tick(_ n: Int) { play(n >= 1 && n <= 3 ? "tick\(n)" : "tickN") }
}

@MainActor func buzz(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .light) { UIImpactFeedbackGenerator(style: style).impactOccurred() }
