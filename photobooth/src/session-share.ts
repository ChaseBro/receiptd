// "Your photos": a short-lived public link to ONE booth session (the 📤 strip
// sticker on the review / printing screens). Works with or without a party.
//
// PIN-gated (the caller checks the PIN first):
//   POST /api/sessions/:id/share   { ttl?: seconds } → { token, url, expiresAt }
//
// Public, token in the path (the on-screen QR / a link sent phone to phone):
//   GET  /api/s/:token             → { session: { id, day, files, meta }, expiresAt }
//   GET  /api/s/:token/file?key=…  → an image of THAT session only
//
// Storage (PHOTOS bucket, under ARCHIVE_PREFIX): `share-s/<token>` →
// { day, id, exp }. Past `exp` every route 404s (and the record is deleted).
// The session needn't be uploaded yet: the page polls until the background
// upload lands. Nothing here reveals the PIN, other sessions or booth internals.

import { contentTypeFor, idTime, nyDay, parseArchiveKey, validPrefix } from "./archive.ts";
import { newToken, sessionShareKey, TOKEN_RE } from "./events.ts";

interface ShareEnv {
  PHOTOS?: R2Bucket;
  ARCHIVE_PREFIX?: string;
}

export const SESSION_SHARE_TTL_S = 24 * 3600;
export const MAX_SESSION_SHARE_TTL_S = 7 * 24 * 3600;

export interface SessionShare { day: string; id: string; exp: number }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

/** POST /api/sessions/:id/share (PIN already checked). Returns null if the path isn't one. */
export async function handleSessionShareCreate(req: Request, url: URL, env: ShareEnv, now = Date.now()): Promise<Response | null> {
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/share$/);
  if (!m) return null;
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const prefix = env.ARCHIVE_PREFIX ?? "";
  if (!env.PHOTOS || !validPrefix(prefix)) return json(503, { error: "archive_disabled" });
  const id = m[1]!;
  const t = idTime(id, now);
  if (t === null) return json(400, { error: "invalid_id" });
  let ttl = SESSION_SHARE_TTL_S;
  const text = await req.text().catch(() => "");
  if (text.trim()) {
    let b: { ttl?: unknown };
    try { b = JSON.parse(text); } catch { return json(400, { error: "invalid_body" }); }
    if (b && typeof b === "object" && b.ttl !== undefined) {
      if (typeof b.ttl !== "number" || !Number.isInteger(b.ttl) || b.ttl < 1 || b.ttl > MAX_SESSION_SHARE_TTL_S) return json(400, { error: "invalid_ttl" });
      ttl = b.ttl;
    }
  }
  const token = newToken();
  const rec: SessionShare = { day: nyDay(t), id, exp: now + ttl * 1000 };
  await env.PHOTOS.put(sessionShareKey(prefix, token), JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
  return json(201, { token, url: `${url.origin}/s/${token}`, expiresAt: new Date(rec.exp).toISOString() });
}

async function lookup(bucket: R2Bucket, prefix: string, token: string, now: number): Promise<SessionShare | null> {
  if (!TOKEN_RE.test(token)) return null;
  const key = sessionShareKey(prefix, token);
  const o = await bucket.get(key);
  if (!o) return null;
  let r: Partial<SessionShare> | null = null;
  try { r = (await o.json()) as Partial<SessionShare>; } catch { r = null; }
  if (!r || typeof r.day !== "string" || typeof r.id !== "string" || typeof r.exp !== "number") return null;
  if (now >= r.exp) { await bucket.delete(key).catch(() => {}); return null; }
  // Never trust a stored record further than the archive's own key rules.
  if (!parseArchiveKey(prefix, `${prefix}${r.day}/${r.id}/meta.json`)) return null;
  return r as SessionShare;
}

/** Public GET /api/s/:token[/file]. Returns null if the path isn't one. */
export async function handleSessionShare(req: Request, url: URL, env: ShareEnv, now = Date.now()): Promise<Response | null> {
  const m = url.pathname.match(/^\/api\/s\/([^/]+)(\/file)?$/);
  if (!m) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method_not_allowed" });
  const prefix = env.ARCHIVE_PREFIX ?? "";
  if (!env.PHOTOS || !validPrefix(prefix)) return json(503, { error: "archive_disabled" });
  const bucket = env.PHOTOS;
  const share = await lookup(bucket, prefix, m[1]!, now);
  if (!share) return json(404, { error: "not_found" });
  const expiresAt = new Date(share.exp).toISOString();

  if (m[2]) {
    const key = url.searchParams.get("key");
    const p = parseArchiveKey(prefix, key);
    if (!p || p.name === "meta.json") return json(400, { error: "invalid_key" });
    if (p.day !== share.day || p.id !== share.id) return json(404, { error: "not_found" });
    const obj = await bucket.get(key!);
    if (!obj) return json(404, { error: "not_found" });
    const h = new Headers({
      "content-type": obj.httpMetadata?.contentType ?? contentTypeFor(key!),
      "content-length": String(obj.size),
      // Originals can be re-uploaded (↻ fixes) for a minute or two after a shoot; short, so expiry bites soon.
      "cache-control": "private, max-age=120",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      etag: obj.httpEtag,
    });
    if (url.searchParams.get("dl") === "1") {
      const t = idTime(p.id, Infinity);
      const stamp = t ? new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-") : p.id;
      h.set("content-disposition", `attachment; filename="photobooth-${stamp}-${p.name}"`);
    }
    return new Response(req.method === "HEAD" ? null : obj.body, { headers: h });
  }

  const objects: R2Object[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {   // a session is ≤ 11 objects; pages just in case
    const page = await bucket.list({ prefix: `${prefix}${share.day}/${share.id}/`, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
    objects.push(...page.objects);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  const files: Record<string, string> = {};
  let meta: Record<string, unknown> | null = null;
  for (const o of objects) {
    const p = parseArchiveKey(prefix, o.key);
    if (!p || p.id !== share.id) continue;
    if (p.name === "meta.json") { try { meta = o.customMetadata?.meta ? JSON.parse(o.customMetadata.meta) : null; } catch {} continue; }
    files[p.name] = o.key;
  }
  // Only what a guest needs: no user agent, face counts, event slug or booth internals.
  const pub = meta ? { capturedAt: meta.capturedAt, theme: meta.theme, shots: meta.shots, printed: meta.printed } : null;
  return json(200, { session: { id: share.id, day: share.day, files, meta: pub }, expiresAt });
}
