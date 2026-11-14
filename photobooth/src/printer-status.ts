// Printer health for the booth UI, from the status snapshot receiptd-cprnt
// keeps in KV (printer:<id>:status, written on change + ~1/min heartbeat).
// CloudPRNT statusCode is "<3-digit code> <text>", URL-encoded by some
// firmware ("410%20Out%20of%20paper").

export type PrinterHealth = {
  code: number | null;      // e.g. 200, 410
  text: string;             // decoded status text
  paperOut: boolean;        // 410: printing stops until a roll goes in
  paperLow: boolean;        // 411: near end (adult hint only)
  coverOpen: boolean;       // 420
  error: boolean;           // any other 4xx/5xx
  online: boolean;          // polled within the last 3 minutes
  lastSeenSec: number | null;
};

export function printerHealth(raw: string | null, now = Date.now()): PrinterHealth {
  const empty: PrinterHealth = { code: null, text: "", paperOut: false, paperLow: false, coverOpen: false, error: false, online: false, lastSeenSec: null };
  if (!raw) return empty;
  let s: { statusCode?: string; lastSeenAt?: number };
  try { s = JSON.parse(raw); } catch { return empty; }
  let text = s.statusCode ?? "";
  try { text = decodeURIComponent(text); } catch {}
  const m = text.match(/^\s*(\d{3})/);
  const code = m ? Number(m[1]) : null;
  const lastSeenSec = typeof s.lastSeenAt === "number" ? Math.max(0, Math.round((now - s.lastSeenAt) / 1000)) : null;
  return {
    code, text,
    paperOut: code === 410,
    paperLow: code === 411,
    coverOpen: code === 420,
    error: code !== null && code >= 400 && ![410, 411, 420].includes(code),
    online: lastSeenSec !== null && lastSeenSec < 180,
    lastSeenSec,
  };
}
