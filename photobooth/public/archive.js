// Photo archive client: keeps every booth session (original frames + the exact
// printed 1-bit strip) by uploading to POST /api/archive in the background.
//
// Never blocks the kid flow: encoding is deferred, uploads run one at a time,
// pause while a print is being sent, and live in a durable IndexedDB queue
// (Blobs) that survives reloads and offline spells. Retries with backoff on
// load / online / an interval. Failures go to /api/log (rate-limited; never
// image data, URLs or the PIN).
//
// The pure helpers at the top have no DOM/IDB dependencies (node --test).

import { encodeBitPNG } from "./archive-codecs.js";

export const QUEUE_CAP_BYTES = 300 * 1024 * 1024;
export const BATCH_BYTES = 10 * 1024 * 1024;     // server caps a request at 12 MB
// Storage budget: ≤ 2048 px long side at q 0.82 ≈ 250–450 KB per frame.
// JPEG only — Safari's canvas encoder has no WebP (it silently returns PNG).
export const JPEG_QUALITY = 0.82;
export const ORIG_MAX_PX = 2048;

/** [w, h] scaled so the long side is ≤ max (never upscaled). */
export function fitSize(w, h, max = ORIG_MAX_PX) {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** `<base36 ms>-<8 hex>`; the server buckets by the timestamp inside it. */
export function newSessionId(now = Date.now(), rand = crypto.getRandomValues(new Uint8Array(4))) {
  return `${now.toString(36)}-${[...rand].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Retry delay after `tries` failures: 5 s doubling, capped at 10 min. */
export function backoffMs(tries) {
  return Math.min(10 * 60 * 1000, 5000 * 2 ** Math.max(0, tries - 1));
}

/**
 * Split files into request-sized batches (greedy, in order). A file bigger
 * than `max` still goes alone (the server decides). No files → one meta-only batch.
 * files: [{ name, bytes }] → [[name, …], …]
 */
export function planBatches(files, max = BATCH_BYTES) {
  const out = [];
  let cur = [], size = 0;
  for (const f of files) {
    if (cur.length && size + f.bytes > max) { out.push(cur); cur = []; size = 0; }
    cur.push(f.name); size += f.bytes;
  }
  if (cur.length || !out.length) out.push(cur);
  return out;
}

/** Ids of the oldest records to drop so the queue fits in `cap` bytes. records: [{ id, createdAt, bytes }] */
export function pickDrops(records, cap = QUEUE_CAP_BYTES) {
  let total = records.reduce((n, r) => n + (r.bytes || 0), 0);
  const drops = [];
  for (const r of [...records].sort((a, b) => a.createdAt - b.createdAt)) {
    if (total <= cap) break;
    drops.push(r.id); total -= r.bytes || 0;
  }
  return drops;
}

/**
 * Upload order: the session whose photos are being shared right now (its "your photos" link
 * is on screen) jumps the queue, even out of a retry backoff; then oldest first.
 * records: [{ id, createdAt, nextAt }] → the due ones, in upload order.
 */
export function orderDue(records, priority = null, now = Date.now()) {
  return records.filter((r) => r.id === priority || r.nextAt <= now)
    .sort((a, b) => (b.id === priority) - (a.id === priority) || a.createdAt - b.createdAt);
}

/** Local meta merge (mirrors the server): later fields win, `printed` is sticky. */
export function mergeQueuedMeta(old, inc) {
  const out = { ...(old || {}), ...inc };
  out.printed = !!(old?.printed || inc.printed);
  if (old?.bytes || inc.bytes) out.bytes = { ...(old?.bytes || {}), ...(inc.bytes || {}) };
  if (!inc.printed && old?.copies !== undefined) out.copies = old.copies;
  return out;
}

// ---------------------------------------------------------------------------
// Durable queue: one record per session { id, createdAt, meta, metaRev,
// files: { name: { blob, rev, bytes } }, bytes, tries, nextAt }.

const DB = "booth-archive", STORE = "sessions";
let dbp = null;
function openDB() {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
const mem = new Map();   // fallback when IndexedDB is unavailable (private mode etc.)
async function tx(mode, fn) {
  const db = await openDB();
  if (!db) return fn(null);
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode), store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = t.onabort = () => reject(t.error || new Error("idb"));
  });
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const qGet = (id) => tx("readonly", (s) => (s ? req2p(s.get(id)) : mem.get(id)));
const qAll = () => tx("readonly", (s) => (s ? req2p(s.getAll()) : [...mem.values()]));
const qPut = (rec) => tx("readwrite", (s) => (s ? req2p(s.put(rec)) : mem.set(rec.id, rec)));
const qDel = (id) => tx("readwrite", (s) => (s ? req2p(s.delete(id)) : mem.delete(id)));
const recBytes = (rec) => Object.values(rec.files).reduce((n, f) => n + f.bytes, 0);

// ---------------------------------------------------------------------------

let getPin = () => "";
let paused = false, flushing = false, inflight = null, kickT = null, logged = 0, lastLog = 0;
let priority = null, again = false;
const LOG_EVERY_MS = 5 * 60 * 1000;

function report(code, extra = {}) {
  console.warn("archive:", code, extra);
  const now = Date.now();
  if (logged >= 20 || now - lastLog < LOG_EVERY_MS) return;
  logged++; lastLog = now;
  fetch("/api/log", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg: "archive:" + code, ...extra }) }).catch(() => {});
}

/** Queue files (+ meta) for a session; replaces same-named files not yet uploaded. */
export async function enqueue(id, meta, files = {}) {
  try {
    const rec = (await qGet(id)) ?? { id, createdAt: Date.now(), meta: {}, metaRev: 0, files: {}, tries: 0, nextAt: 0 };
    rec.meta = mergeQueuedMeta(rec.meta, { ...meta, id });
    rec.metaRev++;
    for (const [name, blob] of Object.entries(files)) {
      rec.files[name] = { blob, rev: (rec.files[name]?.rev ?? 0) + 1, bytes: blob.size };
    }
    rec.bytes = recBytes(rec); rec.tries = 0; rec.nextAt = 0;
    await qPut(rec);
    const all = await qAll();
    const drops = pickDrops(all.map((r) => ({ id: r.id, createdAt: r.createdAt, bytes: r.bytes })));
    for (const d of drops) await qDel(d);
    if (drops.length) report("queue_full_dropped", { dropped: drops.length });
  } catch (e) { report("enqueue_failed", { err: String(e?.name || e) }); }
  kick(id === priority ? 0 : 1500);
}

/**
 * This session's photos are being shared (its "your photos" QR is up): upload it next, now.
 * Safe to call before the session is queued (originals are encoded in the background). Sticky
 * until another session is shared, so its strip.png (queued after the print) jumps the queue too.
 */
export function prioritize(id) {
  priority = id;
  if (flushing) again = true;   // finish the current request, then pick the shared session
  kick(0);
}

/** Wake up for a backed-off record (in addition to the interval). */
let retryT = null;
function retryAt(t) {
  clearTimeout(retryT);
  retryT = setTimeout(() => { flush(); }, Math.max(0, t - Date.now()) + 250);
}

function kick(ms = 0) {
  clearTimeout(kickT);
  kickT = setTimeout(() => { flush(); }, ms);
}

/** Stop uploading (aborts an in-flight request) — e.g. while a print is being sent. */
export function pause() { paused = true; inflight?.abort(); }
export function resume(delay = 3000) { paused = false; kick(delay); }

async function sendBatch(rec, names, signal) {
  const form = new FormData();
  form.append("meta", JSON.stringify(rec.meta));
  for (const n of names) form.append(n, rec.files[n].blob, n);
  const res = await fetch("/api/archive", { method: "POST", headers: { "x-booth-pin": getPin() }, body: form, signal });
  return res.status;
}

/** Upload everything due, one request at a time (the shared session first, see orderDue). */
export async function flush() {
  if (flushing || paused || !getPin() || navigator.onLine === false) return;
  flushing = true; again = false;
  const done = new Set();   // tried this round (sent, backed off or dropped)
  try {
    for (;;) {
      if (paused) break;
      const snap = orderDue((await qAll()).filter((r) => !done.has(r.id)), priority)[0];
      if (!snap) break;
      done.add(snap.id);
      const batches = planBatches(Object.entries(snap.files).map(([name, f]) => ({ name, bytes: f.bytes })));
      for (const names of batches) {
        if (paused) break;
        inflight = new AbortController();
        let status = 0;
        try { status = await sendBatch(snap, names, inflight.signal); } catch { status = 0; }
        inflight = null;
        if (status >= 200 && status < 300) {
          await markSent(snap.id, Object.fromEntries(names.map((n) => [n, snap.files[n].rev])), snap.metaRev);
          continue;
        }
        if (paused) break;                         // aborted by pause(): no penalty
        if (status === 401) return;                // PIN changed: wait for re-unlock
        if (status === 0 || status >= 500 || status === 408 || status === 429) {
          const rec = await qGet(snap.id);
          // Re-queued meanwhile (new files/meta)? Leave it due now; else back off.
          if (rec && rec.metaRev === snap.metaRev) { rec.tries++; rec.nextAt = Date.now() + backoffMs(rec.tries); await qPut(rec); retryAt(rec.nextAt); }
          if (status) report("upload_retry", { status, tries: (rec?.tries ?? 0) });
          if (status === 0) return;                // offline / network down: stop this round
        } else {
          await qDel(snap.id);                     // rejected for good (bad data): don't poison the queue
          report("upload_rejected", { status, id: snap.id });
        }
        break;
      }
    }
  } catch (e) {
    report("flush_failed", { err: String(e?.name || e) });
  } finally {
    flushing = false; inflight = null;
    if (again && !paused) kick(0);   // prioritize() / enqueue() landed mid-round
  }
}

/** Drop files that were uploaded (unless replaced meanwhile); delete the record once nothing's left. */
async function markSent(id, sentRevs, metaRev) {
  const rec = await qGet(id);
  if (!rec) return;
  for (const [n, rev] of Object.entries(sentRevs)) if (rec.files[n]?.rev === rev) delete rec.files[n];
  rec.bytes = recBytes(rec);
  if (!Object.keys(rec.files).length && rec.metaRev === metaRev) await qDel(id);
  else { rec.tries = 0; rec.nextAt = 0; await qPut(rec); }
}

/** Arm retries: now-ish, when back online, when shown again, and every minute. */
export function startArchive(pinFn) {
  getPin = pinFn;
  navigator.storage?.persist?.().catch(() => {});
  addEventListener("online", () => kick(2000));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(5000); });
  setInterval(() => kick(), 60000);
  kick(10000);
}

// ---------------------------------------------------------------------------
// Session helpers used by index.html.

/**
 * frames: [{ canvas, deg }] — full-resolution, unmirrored camera frames, plus the tilt rotation to make it upright. `rotate(canvas, deg)`
 * is the page's rotation helper. Encoding runs after `delay` so the review
 * screen and dithering get the CPU first.
 */
export function archiveOriginals(id, frames, rotations, meta, rotate) {
  const rot = rotations.slice();
  setTimeout(async () => {
    try {
      const files = await encodeOriginals(frames, rot, rotate);
      const bytes = Object.fromEntries(Object.entries(files).map(([n, b]) => [n, b.size]));
      await enqueue(id, { ...meta, rotations: rot, bytes }, files);
    } catch (e) { report("encode_failed", { err: String(e?.name || e) }); }
  }, 600);
}

/** The originals as archived (upright + ↻, ≤ 2048 px, JPEG): { "orig-N.jpg": Blob }. Also what "share this photo" sends. */
export async function encodeOriginals(frames, rotations, rotate) {
  const files = {};
  for (let i = 0; i < frames.length; i++) {
    const { canvas, deg } = frames[i];
    const up = rotate(downscale(canvas, ORIG_MAX_PX), (deg + (rotations[i] ?? 0)) % 360);
    const blob = await up.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
    // Encoders may silently fall back to PNG for unsupported types: only keep real JPEGs.
    if (blob.type !== "image/jpeg") { report("encode_wrong_type", { type: blob.type }); continue; }
    files[`orig-${i + 1}.jpg`] = blob;
  }
  return files;
}

/** Long side ≤ `max` (never upscales). */
function downscale(src, max) {
  const [w, h] = fitSize(src.width, src.height, max);
  if (w === src.width && h === src.height) return src;
  const c = new OffscreenCanvas(w, h), ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

/** The exact printed bitmap (copy 1) as a true 1-bit greyscale PNG + printed meta. */
export async function archiveStrip(id, bits, w, h, meta) {
  try {
    const png = await encodeBitPNG(bits, w, h);
    await enqueue(id, { ...meta, printed: true, bytes: { "strip.png": png.length } },
      { "strip.png": new Blob([png], { type: "image/png" }) });
  } catch (e) { report("strip_failed", { err: String(e?.name || e) }); }
}
