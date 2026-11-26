// What the printer needs, from GET /api/printer (src/printer-status.ts). Pure logic, so it runs
// under node --test; mirrored by PrinterHealth.state / PrinterWake in ios/BoothCore/.../BoothAPI.swift.
//
// With MQTT the printer only polls when poked (its own fallback poll is hourly), so a stale
// lastSeen alone doesn't mean it's off: it's napping. The booth wakes it (POST /api/nudge, see
// wakeStep) and only calls it offline once a nudge got no check-in within WAKE.windowMs.
//
// One state, in priority order: out of paper, cover open, error (authoritative status codes, even
// when stale), then offline (stale + a wake-up nudge went unanswered), asleep (stale, not yet
// woken / waking), paper low, ready. The camera badge shows the four that need a grown-up
// (needsAdult); asleep gets a quiet badge (softBadge): no "!", no wiggle, no red.

export const STATES = ["paperOut", "cover", "error", "offline", "asleep", "paperLow", "ready"];
/** Drawn icon per state (icons.js). */
export const STATE_ICON = { offline: "pOffline", asleep: "pAsleep", paperOut: "pPaperOut", cover: "pCover", error: "pError", paperLow: "pPaperLow", ready: "pReady" };

/** Wake-up timing: at most one automatic nudge per cooldown while the booth is in use; after a
 *  nudge, re-check every recheckMs; no check-in within windowMs → offline. */
export const WAKE = { cooldownMs: 120000, windowMs: 25000, recheckMs: 4000 };
/** phase: "idle" | "waking"; failed: the last nudge went unanswered (sticky until a check-in). */
export const newWake = () => ({ phase: "idle", nudgedAt: 0, failed: false });

/**
 * Advance the wake-up machine with a fresh /api/printer answer `h` at `now`.
 *   inUse: the camera screen is being used (automatic nudges only then);
 *   force: nudge regardless of the cooldown (right before / after a print).
 * → { wake, nudge (POST /api/nudge now), recheck (ask /api/printer again in WAKE.recheckMs) }
 */
export function wakeStep(wake, h, now = Date.now(), { inUse = true, force = false } = {}) {
  const w = { ...newWake(), ...wake };
  if (!h || typeof h !== "object") return { wake: w, nudge: false, recheck: false };
  if (h.online) return { wake: { phase: "idle", nudgedAt: w.nudgedAt, failed: false }, nudge: false, recheck: false };
  if (w.phase === "waking" && now - w.nudgedAt >= WAKE.windowMs) { w.phase = "idle"; w.failed = true; }
  let nudge = false;
  if (w.phase !== "waking" && (force || (inUse && now - w.nudgedAt >= WAKE.cooldownMs))) {
    nudge = true; w.phase = "waking"; w.nudgedAt = now;
  }
  return { wake: w, nudge, recheck: w.phase === "waking" };
}

/** h: the /api/printer body (or the `printer` field of /api/jobs/:id), or null before the first answer.
 *  wake: the wakeStep state (omitted → a stale printer counts as asleep). */
export function printerState(h, wake = null) {
  if (!h || typeof h !== "object") return null;
  if (h.paperOut) return "paperOut";
  if (h.coverOpen) return "cover";
  if (h.error) return "error";
  if (!h.online) return wake?.failed ? "offline" : "asleep";
  if (h.paperLow) return "paperLow";
  return "ready";
}
/** The camera badge (and the printing screen's wait sticker) shows these, loud. */
export const needsAdult = (state) => state === "offline" || state === "paperOut" || state === "cover" || state === "error";
/** …and this one quietly (warning level: no "!", no wiggle, no red). */
export const softBadge = (state) => state === "asleep";

/** "2:14 pm" for a moment `sec` seconds before `now`. */
export function clockAgo(sec, now = Date.now()) {
  const d = new Date(now - sec * 1000);
  let h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "am" : "pm"}`;
}
/** "just now" / "5 min ago" / "2h ago" / "3 days ago". */
export function ago(sec) {
  if (typeof sec !== "number") return "never";
  if (sec < 90) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)} days ago`;
}

/** The one-line adult label for a tap on the printer badge (short; adults only). */
export function printerHint(h, now = Date.now(), wake = null) {
  const s = printerState(h, wake);
  if (s === "offline") {
    const seen = typeof h.lastSeenSec === "number" ? `last seen ${clockAgo(h.lastSeenSec, now)}` : "not seen yet";
    return `Printer offline · ${seen} · Check its power & Wi-Fi`;
  }
  if (s === "asleep") return wake?.phase === "waking" ? "Printer napping · waking it up…" : `Printer napping · last check-in ${ago(h.lastSeenSec)}`;
  return {
    paperOut: "Out of paper",
    cover: "Cover open",
    error: "Printer error — turn it off and on",
    paperLow: "Paper low",
    ready: "Printer ready",
  }[s] ?? "Printer status unknown";
}

/** Settings status tiles: [title, sub] for the printer and the paper. */
export function statusWords(h, now = Date.now(), wake = null) {
  const s = printerState(h, wake), stale = !!h && !h.online;
  const printer = s === null ? ["Printer", "checking…"]
    : s === "offline" ? ["Printer offline", typeof h.lastSeenSec === "number" ? `since ${clockAgo(h.lastSeenSec, now)}` : "never seen"]
    : s === "asleep" ? ["Printer napping", wake?.phase === "waking" ? "waking it up…" : `last check-in ${ago(h.lastSeenSec)}`]
    : s === "error" ? ["Printer error", "turn it off and on"]
    : stale ? ["Printer", `last check-in ${ago(h.lastSeenSec)}`]
    : ["Printer ready", "online"];
  const paper = !h ? ["Paper", "—"]
    : h.paperOut ? ["Out of paper", h.coverOpen ? "cover open" : "load a roll"]
    : h.coverOpen ? ["Cover open", "close the lid"]
    : s === "offline" ? ["Paper", "unknown while offline"]
    : h.paperLow ? ["Paper low", "cover closed"]
    : stale ? ["Paper OK", "as of its last check-in"]
    : ["Paper OK", "cover closed"];
  return { printer, paper, stale, state: s };
}
