// What the printer needs, from GET /api/printer (src/printer-status.ts). Pure logic, so it runs
// under node --test; mirrored by PrinterHealth.state in ios/BoothCore/.../BoothAPI.swift.
//
// One state, in priority order: offline (no poll in 3 min: paper/cover info is stale then),
// out of paper, cover open, error, paper low, ready. The kid-facing camera badge shows only the
// four that need a grown-up; paper low is for the settings status strip.

export const STATES = ["offline", "paperOut", "cover", "error", "paperLow", "ready"];
/** Drawn icon per state (icons.js). */
export const STATE_ICON = { offline: "pOffline", paperOut: "pPaperOut", cover: "pCover", error: "pError", paperLow: "pPaperLow", ready: "pReady" };

/** h: the /api/printer body (or the `printer` field of /api/jobs/:id), or null before the first answer. */
export function printerState(h) {
  if (!h || typeof h !== "object") return null;
  if (!h.online) return "offline";
  if (h.paperOut) return "paperOut";
  if (h.coverOpen) return "cover";
  if (h.error) return "error";
  if (h.paperLow) return "paperLow";
  return "ready";
}
/** The camera badge (and the printing screen's wait sticker) shows only for these. */
export const needsAdult = (state) => state === "offline" || state === "paperOut" || state === "cover" || state === "error";

/** "2:14 pm" for a moment `sec` seconds before `now`. */
export function clockAgo(sec, now = Date.now()) {
  const d = new Date(now - sec * 1000);
  let h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")} ${d.getHours() < 12 ? "am" : "pm"}`;
}

/** The one-line adult label for a tap on the printer badge (short; adults only). */
export function printerHint(h, now = Date.now()) {
  const s = printerState(h);
  if (s === "offline") {
    const seen = typeof h.lastSeenSec === "number" ? `last seen ${clockAgo(h.lastSeenSec, now)}` : "not seen yet";
    return `Printer offline · ${seen} · Check its power & Wi-Fi`;
  }
  return {
    paperOut: "Out of paper",
    cover: "Cover open",
    error: "Printer error — turn it off and on",
    paperLow: "Paper low",
    ready: "Printer ready",
  }[s] ?? "Printer status unknown";
}

/** Settings status tiles: [title, sub] for the printer and the paper. */
export function statusWords(h, now = Date.now()) {
  const s = printerState(h);
  const printer = s === null ? ["Printer", "checking…"]
    : s === "offline" ? ["Printer offline", typeof h.lastSeenSec === "number" ? `since ${clockAgo(h.lastSeenSec, now)}` : "never seen"]
    : s === "error" ? ["Printer error", "turn it off and on"]
    : ["Printer ready", "online"];
  const paper = !h ? ["Paper", "—"]
    : s === "offline" ? ["Paper", "unknown while offline"]
    : h.paperOut ? ["Out of paper", h.coverOpen ? "cover open" : "load a roll"]
    : h.coverOpen ? ["Cover open", "close the lid"]
    : h.paperLow ? ["Paper low", "cover closed"]
    : ["Paper OK", "cover closed"];
  return { printer, paper, stale: s === "offline" };
}
