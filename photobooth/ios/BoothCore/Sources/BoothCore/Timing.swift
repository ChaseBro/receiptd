import Foundation

// Booth timings (port of public/timing.js, same numbers): the capture countdown and how long the
// printing screen stays up.

/// Settings → Countdown, in seconds: 0 = instant (the default), up to 10.
public let COUNTDOWN_DEFAULT = 0
public let COUNTDOWN_MAX = 10
/// Strips: the beat (s) between shots so people can pose, even when the countdown is instant.
public let BETWEEN_SHOTS_S = 1

/// A stored countdown → 0...COUNTDOWN_MAX (missing → instant).
public func clampCountdown(_ v: Int?) -> Int { min(COUNTDOWN_MAX, max(0, v ?? COUNTDOWN_DEFAULT)) }

/// Countdown (s) before shot `i` (0-based): the setting for the first, at least the posing beat after.
public func shotCountdown(_ count: Int, shot i: Int) -> Int {
    let c = clampCountdown(count)
    return i == 0 ? c : max(c, BETWEEN_SHOTS_S)
}

// Printing screen. Once POST /api/print says 201 the job is safely queued: the printer takes it
// when it polls (the booth nudges it over MQTT), so the screen doesn't wait for the printer. It
// shows the printing animation for a beat, then celebrates and goes back to the camera.
/// Shortest time (s) on the printing screen after the 201, even if the job finishes at once.
public let PRINT_BEAT: Double = 1.5
/// Longest time (s) on the printing screen after the 201; the job may still be in line.
public let PRINT_HOLD: Double = 4
/// The confetti finish (s) before the camera comes back.
public let CELEBRATE: Double = 2.4

/// Leave the printing screen now? `elapsed` s since the 201, `status` the job's last status.
public func printScreenDone(elapsed: Double, status: String?) -> Bool {
    elapsed >= PRINT_HOLD || (status == "completed" && elapsed >= PRINT_BEAT)
}

/// Background follow-up of a queued job (s): re-nudges + printer badge, never blocks a shot.
public func followSeconds(copies: Int) -> Double { 60 + 30 * Double(max(1, copies)) }
/// Rough print time (s) per strip of height `h` px.
public func perCopySeconds(height h: Int) -> Double { 1.5 + Double(h) * 0.002 }
/// Re-send the MQTT "poll now"? Not done after ~6 s per nudge so far (+ print time of the extra
/// copies) in case the first trigger got lost; at most 5.
public func nudgeDue(sinceSent: Double, nudges: Int, copies: Int, height: Int) -> Bool {
    nudges < 5 && sinceSent > 6 * Double(nudges + 1) + perCopySeconds(height: height) * Double(copies - 1)
}
