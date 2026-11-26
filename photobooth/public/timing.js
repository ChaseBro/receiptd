// Booth timings: the capture countdown and how long the printing screen stays up.
// Pure logic (no DOM) so it runs under node --test. iOS: BoothCore/Timing.swift (same numbers).

/** Settings → Countdown, in seconds: 0 = instant (the default), up to 10. */
export const COUNTDOWN_DEFAULT = 0;
export const COUNTDOWN_MAX = 10;
/** Strips: the beat (s) between shots so people can pose, even when the countdown is instant. */
export const BETWEEN_SHOTS_S = 1;

/** A stored countdown → an integer 0..COUNTDOWN_MAX (missing / bad → instant). */
export function clampCountdown(v) {
  const n = Math.round(Number(v ?? COUNTDOWN_DEFAULT));
  return Number.isFinite(n) ? Math.min(COUNTDOWN_MAX, Math.max(0, n)) : COUNTDOWN_DEFAULT;
}

/** Countdown (s) before shot `i` (0-based): the setting for the first, at least the posing beat after. */
export function shotCountdown(count, i) {
  const c = clampCountdown(count);
  return i === 0 ? c : Math.max(c, BETWEEN_SHOTS_S);
}

// Printing screen. Once POST /api/print says 201 the job is safely queued: the printer takes it
// when it polls (the booth nudges it over MQTT), so the screen doesn't wait for the printer. It
// shows the printing animation for a beat, then celebrates and goes back to the camera.
/** Shortest time (ms) on the printing screen after the 201, even if the job finishes at once. */
export const PRINT_BEAT_MS = 1500;
/** Longest time (ms) on the printing screen after the 201; the job may still be in line. */
export const PRINT_HOLD_MS = 4000;
/** The confetti finish (ms) before the camera comes back. */
export const CELEBRATE_MS = 2400;

/** Leave the printing screen now? `elapsed` ms since the 201, `status` the job's last status. */
export function printScreenDone(elapsed, status) {
  return elapsed >= PRINT_HOLD_MS || (status === "completed" && elapsed >= PRINT_BEAT_MS);
}

/** Background follow-up of a queued job (ms): re-nudges + printer badge, never blocks a shot. */
export const followMs = (copies) => 60000 + 30000 * Math.max(1, copies);
/** Rough print time (ms) per strip of height `h` px. */
export const perCopyMs = (h) => 1500 + h * 2;
/**
 * Re-send the MQTT "poll now"? Not done after ~6 s per nudge so far (+ print time of the extra
 * copies) in case the first trigger got lost; at most 5.
 */
export function nudgeDue(sinceSent, nudges, copies, h) {
  return nudges < 5 && sinceSent > 6000 * (nudges + 1) + perCopyMs(h) * (copies - 1);
}
