// Photo archive: pure helpers (no Worker APIs) so they run under `node --test`
// too (Node strips the types). Every session is kept in the private
// `receiptd-photos` R2 bucket:
//
//   ${prefix}${YYYY-MM-DD}/${id}/meta.json      merged session metadata
//   ${prefix}${YYYY-MM-DD}/${id}/orig-N.jpg     camera frames (upright, as seen on screen)
//   ${prefix}${YYYY-MM-DD}/${id}/strip.png      the exact 1-bit bitmap that printed (copy 1)
//
// The day comes from the timestamp inside the session id (America/New_York),
// not from the request, so re-uploads of a session always land in one folder.

export const ARCHIVE_TZ = "America/New_York";
export const MAX_ARCHIVE_REQUEST = 12 * 1024 * 1024;
export const MAX_ARCHIVE_FILE = 8 * 1024 * 1024;
export const MAX_SHOTS = 9;
/** customMetadata on R2 objects is capped at 2 KB in total. */
const MAX_CUSTOM_META = 1800;

/** `<base36 ms timestamp>-<8 hex>`, e.g. `mhz3k2a1-0f3a9c11`. */
export const ID_RE = /^([0-9a-z]{8,10})-([0-9a-f]{8})$/;
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const FILE_RE = /^(meta\.json|orig-[1-9]\.jpg|strip\.png)$/;
/** Names a client may upload (meta.json is written by the server). */
export const UPLOAD_RE = /^(orig-[1-9]\.jpg|strip\.png)$/;
/** ARCHIVE_PREFIX: "" (prod) or a short path like "staging/". */
export const PREFIX_RE = /^([a-z0-9-]{1,32}\/)?$/;

const EARLIEST = Date.UTC(2025, 0, 1);

/** Capture time (ms) encoded in a session id, or null if the id is malformed/implausible. */
export function idTime(id: string, now = Date.now()): number | null {
  const m = ID_RE.exec(id);
  if (!m) return null;
  const t = parseInt(m[1]!, 36);
  if (!Number.isSafeInteger(t) || t < EARLIEST || t > now + 36 * 3600 * 1000) return null;
  return t;
}

/** Calendar day (YYYY-MM-DD) of an instant in the archive's timezone. */
export function nyDay(t: number | Date, tz = ARCHIVE_TZ): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(typeof t === "number" ? new Date(t) : t);
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function isDay(s: unknown): s is string {
  if (typeof s !== "string" || !DAY_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validPrefix(p: unknown): p is string {
  return typeof p === "string" && PREFIX_RE.test(p);
}

export function archiveKey(prefix: string, day: string, id: string, name: string): string {
  if (!validPrefix(prefix) || !isDay(day) || !ID_RE.test(id) || !FILE_RE.test(name)) throw new Error("bad_key");
  return `${prefix}${day}/${id}/${name}`;
}

/** Parse + validate an object key under `prefix`. Anything else (traversal, other envs' prefixes) → null. */
export function parseArchiveKey(prefix: string, key: unknown): { day: string; id: string; name: string } | null {
  if (!validPrefix(prefix) || typeof key !== "string" || key.length > 200 || !key.startsWith(prefix)) return null;
  const parts = key.slice(prefix.length).split("/");
  if (parts.length !== 3) return null;
  const [day, id, name] = parts as [string, string, string];
  if (!isDay(day) || !ID_RE.test(id) || !FILE_RE.test(name)) return null;
  return { day, id, name };
}

export function contentTypeFor(name: string): string {
  if (name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  return "application/json";
}

/** Does the payload look like the file type its name claims (magic bytes)? */
export function sniffOK(name: string, head: Uint8Array): boolean {
  if (name.endsWith(".jpg")) return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (name.endsWith(".png")) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return head.length >= 8 && sig.every((b, i) => head[i] === b);
  }
  return false;
}

export interface ArchiveMeta {
  id: string;
  capturedAt: string;
  theme?: string;
  shots?: number;
  faces?: (number | null)[] | null;
  rotations?: number[];
  mirrored?: boolean;
  ticket?: number;
  copies?: number;
  printed: boolean;
  printedAt?: string;
  ua?: string;
  files?: string[];
  /** Stored size per file (measured by the server). */
  bytes?: Record<string, number>;
  createdAt?: string;
  updatedAt?: string;
}

const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined;

/**
 * Whitelist + bound client-sent metadata. Unknown fields are dropped; bad
 * optional fields are dropped rather than failing the upload (we'd rather keep
 * the photos). `id` must match the session id; `capturedAt` falls back to the
 * id's timestamp.
 */
export function sanitizeMeta(raw: unknown, id: string, idMs: number): ArchiveMeta {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: ArchiveMeta = { id, capturedAt: new Date(idMs).toISOString(), printed: r.printed === true };
  if (typeof r.capturedAt === "string" && r.capturedAt.length <= 40) {
    const t = Date.parse(r.capturedAt);
    if (Number.isFinite(t)) out.capturedAt = new Date(t).toISOString();
  }
  if (typeof r.theme === "string" && /^[a-z0-9-]{1,20}$/.test(r.theme)) out.theme = r.theme;
  const shots = int(r.shots, 1, MAX_SHOTS);
  if (shots !== undefined) out.shots = shots;
  if (Array.isArray(r.faces) && r.faces.length <= MAX_SHOTS) {
    out.faces = r.faces.map((f) => int(f, 0, 99) ?? null);
  }
  if (Array.isArray(r.rotations) && r.rotations.length <= MAX_SHOTS && r.rotations.every((d) => [0, 90, 180, 270].includes(d as number))) {
    out.rotations = r.rotations as number[];
  }
  if (typeof r.mirrored === "boolean") out.mirrored = r.mirrored;
  const ticket = int(r.ticket, 0, 1e9);
  if (ticket !== undefined) out.ticket = ticket;
  const copies = int(r.copies, 0, 6);
  if (copies !== undefined) out.copies = copies;
  if (typeof r.ua === "string") out.ua = r.ua.slice(0, 300);
  return out;
}

/**
 * Merge a new upload's metadata into what's stored. Re-uploads are idempotent:
 * `printed` is sticky (false → true, never back), `printedAt`/`createdAt` keep
 * their first value, `files` is the union of everything stored so far and `bytes` their latest stored sizes.
 */
export function mergeMeta(old: Partial<ArchiveMeta> | null, inc: ArchiveMeta, sizes: Record<string, number>, nowISO: string): ArchiveMeta {
  const files = Object.keys(sizes);
  const prev = old && typeof old === "object" ? old : {};
  const printed = prev.printed === true || inc.printed;
  const out: ArchiveMeta = { ...prev, ...inc, printed } as ArchiveMeta;
  // A later "not printed" upload (e.g. re-rotated originals) must not erase print info.
  if (!inc.printed && prev.copies !== undefined) out.copies = prev.copies;
  if (printed) out.printedAt = prev.printedAt ?? nowISO;
  else delete out.printedAt;
  out.files = [...new Set([...(Array.isArray(prev.files) ? prev.files : []), ...files])].filter((f) => FILE_RE.test(f)).sort();
  out.bytes = Object.fromEntries(Object.entries({ ...(prev.bytes && typeof prev.bytes === "object" ? prev.bytes : {}), ...sizes })
    .filter(([f, n]) => FILE_RE.test(f) && Number.isInteger(n) && n >= 0).sort(([a], [b]) => a.localeCompare(b)));
  out.createdAt = prev.createdAt ?? nowISO;
  out.updatedAt = nowISO;
  return out;
}

/** Meta as a string small enough for R2 customMetadata (so a list() returns it), or null. */
export function compactMeta(m: ArchiveMeta): string | null {
  let s = JSON.stringify(m);
  if (s.length <= MAX_CUSTOM_META) return s;
  const { ua: _ua, ...rest } = m;
  s = JSON.stringify(rest);
  return s.length <= MAX_CUSTOM_META ? s : null;
}

/** Group listed object keys into sessions: [{ id, day, files: { name: key } }], newest first. */
export function groupSessions(prefix: string, keys: string[]): { id: string; day: string; files: Record<string, string> }[] {
  const by = new Map<string, { id: string; day: string; files: Record<string, string> }>();
  for (const key of keys) {
    const p = parseArchiveKey(prefix, key);
    if (!p) continue;
    const s = by.get(p.id) ?? { id: p.id, day: p.day, files: {} };
    s.files[p.name] = key;
    by.set(p.id, s);
  }
  return [...by.values()].sort((a, b) => (idTime(b.id, Infinity) ?? 0) - (idTime(a.id, Infinity) ?? 0));
}
