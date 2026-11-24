// Events + public albums.
//
// PIN-gated (the caller checks the PIN first):
//   GET    /api/events                    → { events, active }
//   POST   /api/events                    { name, date?, themes?, theme?, footer?, qr? } → { event }
//   GET    /api/events/active             → { event | null }   (booths poll this)
//   POST   /api/events/active             { slug | null }
//   PUT    /api/events/:slug              partial update → { event }
//   POST   /api/events/:slug/share        rotate the album link → { event }
//   POST   /api/events/:slug/attach       { day } | { day, ids } → { added }
//   POST   /api/events/:slug/detach       { day, id }  (hide a session from the album)
//
// Public, token in the path (the QR code on a strip / the party sign):
//   GET    /api/album/:token              → { event, sessions: [{ id, day, files, meta }] }
//   GET    /api/album/:token/file?key=…   → the image, only if its session is in the album
//
// Photos stay in the private bucket: the album hands out nothing but its own
// keys, and file reads re-check that the session belongs to the album.

import { contentTypeFor, groupSessions, idTime, isDay, ID_RE, parseArchiveKey, validPrefix } from "./archive.ts";
import {
  activeKey, cleanEventInput, eventKey, indexKey, indexPrefix, newToken, parseIndexKey, publicEvent,
  shareKey, slugify, SLUG_RE, TOKEN_RE, type BoothEvent,
} from "./events.ts";

interface EventsEnv {
  PHOTOS?: R2Bucket;
  ARCHIVE_PREFIX?: string;
}

const MAX_EVENTS = 200;
const MAX_ALBUM_DAYS = 14;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

async function readJSON<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const o = await bucket.get(key);
  if (!o) return null;
  try { return (await o.json()) as T; } catch { return null; }
}
async function body(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return undefined; }
}
const putJSON = (bucket: R2Bucket, key: string, v: unknown) =>
  bucket.put(key, JSON.stringify(v, null, 2), { httpMetadata: { contentType: "application/json" } });

export async function getEvent(bucket: R2Bucket, prefix: string, slug: string): Promise<BoothEvent | null> {
  return SLUG_RE.test(slug) ? readJSON<BoothEvent>(bucket, eventKey(prefix, slug)) : null;
}

async function activeSlug(bucket: R2Bucket, prefix: string): Promise<string | null> {
  const o = await bucket.get(activeKey(prefix));
  const s = o ? (await o.text()).trim() : "";
  return SLUG_RE.test(s) ? s : null;
}

async function listAll(bucket: R2Bucket, opts: R2ListOptions): Promise<R2Objects[]> {
  const pages: R2Objects[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await bucket.list({ ...opts, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  return pages;
}

/** Add a session to an event's album (idempotent). Called from archive uploads too. */
export async function indexSession(bucket: R2Bucket, prefix: string, slug: string, day: string, id: string): Promise<void> {
  await bucket.put(indexKey(prefix, slug, day, id), "");
}

/** Returns a Response for event/album routes, or null if the path isn't one. */
export async function handleEvents(req: Request, url: URL, env: EventsEnv): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/events")) return null;
  if (p !== "/api/events" && !p.startsWith("/api/events/")) return null;
  const prefix = env.ARCHIVE_PREFIX ?? "";
  if (!env.PHOTOS || !validPrefix(prefix)) return json(503, { error: "archive_disabled" });
  const bucket = env.PHOTOS;

  if (p === "/api/events" && req.method === "GET") {
    const pages = await listAll(bucket, { prefix: `${prefix}events/`, delimiter: "/" });
    const slugs = pages.flatMap((pg) => pg.delimitedPrefixes)
      .map((d) => d.slice(`${prefix}events/`.length).replace(/\/$/, ""))
      .filter((s) => SLUG_RE.test(s)).slice(0, MAX_EVENTS);
    const events = (await Promise.all(slugs.map((s) => getEvent(bucket, prefix, s)))).filter(Boolean) as BoothEvent[];
    events.sort((a, b) => (b.date ?? b.createdAt).localeCompare(a.date ?? a.createdAt));
    return json(200, { events, active: await activeSlug(bucket, prefix) });
  }

  if (p === "/api/events" && req.method === "POST") {
    const c = cleanEventInput(await body(req));
    if (!c.ok) return json(400, { error: c.error });
    const base = slugify(c.value.name!);
    let slug = base;
    for (let n = 2; await bucket.head(eventKey(prefix, slug)); n++) {
      if (n > 50) return json(409, { error: "slug_taken" });
      slug = `${base.slice(0, 36)}-${n}`;
    }
    const now = new Date().toISOString();
    const event: BoothEvent = { themes: [], qr: true, ...c.value, slug, share: newToken(), createdAt: now, updatedAt: now } as BoothEvent;
    await putJSON(bucket, eventKey(prefix, slug), event);
    await bucket.put(shareKey(prefix, event.share), slug);
    return json(201, { event });
  }

  if (p === "/api/events/active") {
    if (req.method === "GET") {
      const slug = await activeSlug(bucket, prefix);
      return json(200, { event: slug ? await getEvent(bucket, prefix, slug) : null });
    }
    if (req.method === "POST") {
      const b = (await body(req)) as { slug?: unknown } | undefined;
      const slug = b?.slug;
      if (slug === null || slug === "") {
        await bucket.delete(activeKey(prefix));
        return json(200, { event: null });
      }
      if (typeof slug !== "string" || !SLUG_RE.test(slug)) return json(400, { error: "invalid_slug" });
      const event = await getEvent(bucket, prefix, slug);
      if (!event) return json(404, { error: "not_found" });
      await bucket.put(activeKey(prefix), slug);
      return json(200, { event });
    }
    return json(405, { error: "method_not_allowed" });
  }

  const m = p.match(/^\/api\/events\/([a-z0-9-]+)(?:\/(share|attach|detach))?$/);
  if (!m || !SLUG_RE.test(m[1]!)) return json(404, { error: "not_found" });
  const slug = m[1]!, action = m[2];
  const event = await getEvent(bucket, prefix, slug);
  if (!event) return json(404, { error: "not_found" });

  if (!action && req.method === "GET") return json(200, { event });

  if (!action && req.method === "PUT") {
    const c = cleanEventInput(await body(req), true);
    if (!c.ok) return json(400, { error: c.error });
    const next: BoothEvent = { ...event, ...c.value, updatedAt: new Date().toISOString() };
    if (next.theme && next.themes.length && !next.themes.includes(next.theme)) next.theme = next.themes[0];
    if (c.value.date === undefined && "date" in c.value) delete next.date;
    if (c.value.theme === undefined && "theme" in c.value) delete next.theme;
    await putJSON(bucket, eventKey(prefix, slug), next);
    return json(200, { event: next });
  }

  if (action === "share" && req.method === "POST") {
    const old = event.share;
    const next: BoothEvent = { ...event, share: newToken(), updatedAt: new Date().toISOString() };
    await bucket.put(shareKey(prefix, next.share), slug);
    await putJSON(bucket, eventKey(prefix, slug), next);
    await bucket.delete(shareKey(prefix, old));
    return json(200, { event: next });
  }

  if (action === "attach" && req.method === "POST") {
    const b = (await body(req)) as { day?: unknown; ids?: unknown } | undefined;
    if (!isDay(b?.day)) return json(400, { error: "invalid_day" });
    const day = b!.day as string;
    let ids: string[];
    if (b!.ids !== undefined) {
      if (!Array.isArray(b!.ids) || b!.ids.length > 500 || !b!.ids.every((i) => typeof i === "string" && ID_RE.test(i))) {
        return json(400, { error: "invalid_ids" });
      }
      ids = b!.ids as string[];
    } else {
      const pages = await listAll(bucket, { prefix: `${prefix}${day}/`, delimiter: "/" });
      ids = pages.flatMap((pg) => pg.delimitedPrefixes).map((d) => d.slice(`${prefix}${day}/`.length).replace(/\/$/, "")).filter((i) => ID_RE.test(i));
    }
    await Promise.all(ids.map((id) => indexSession(bucket, prefix, slug, day, id)));
    return json(200, { added: ids.length });
  }

  if (action === "detach" && req.method === "POST") {
    const b = (await body(req)) as { day?: unknown; id?: unknown } | undefined;
    if (!isDay(b?.day) || typeof b?.id !== "string" || !ID_RE.test(b.id)) return json(400, { error: "invalid_session" });
    await bucket.delete(indexKey(prefix, slug, b.day as string, b.id));
    return json(200, { ok: true });
  }

  return json(405, { error: "method_not_allowed" });
}

/** Public album routes (no PIN). Returns null if the path isn't one. */
export async function handleAlbum(req: Request, url: URL, env: EventsEnv): Promise<Response | null> {
  const m = url.pathname.match(/^\/api\/album\/([a-z0-9]+)(\/file)?$/);
  if (!m) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "method_not_allowed" });
  const prefix = env.ARCHIVE_PREFIX ?? "";
  if (!env.PHOTOS || !validPrefix(prefix)) return json(503, { error: "archive_disabled" });
  const bucket = env.PHOTOS;
  const token = m[1]!;
  if (!TOKEN_RE.test(token)) return json(404, { error: "not_found" });
  const so = await bucket.get(shareKey(prefix, token));
  const slug = so ? (await so.text()).trim() : "";
  const event = slug ? await getEvent(bucket, prefix, slug) : null;
  if (!event || event.share !== token) return json(404, { error: "not_found" });

  if (m[2]) {
    const key = url.searchParams.get("key");
    const parsed = parseArchiveKey(prefix, key);
    if (!parsed || parsed.name === "meta.json") return json(400, { error: "invalid_key" });
    if (!(await bucket.head(indexKey(prefix, slug, parsed.day, parsed.id)))) return json(404, { error: "not_found" });
    const obj = await bucket.get(key!);
    if (!obj) return json(404, { error: "not_found" });
    const h = new Headers({
      "content-type": obj.httpMetadata?.contentType ?? contentTypeFor(key!),
      "content-length": String(obj.size),
      // Originals can be re-uploaded (↻ fixes) for a minute or two after a shoot.
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
      etag: obj.httpEtag,
    });
    if (url.searchParams.get("dl") === "1") {
      const t = idTime(parsed.id, Infinity);
      const stamp = t ? new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-") : parsed.id;
      h.set("content-disposition", `attachment; filename="${slug}-${stamp}-${parsed.name}"`);
    }
    return new Response(req.method === "HEAD" ? null : obj.body, { headers: h });
  }

  // Album listing: the index says which sessions; one listing per day gives
  // their files + compact meta (instead of one request per session).
  const idx = (await listAll(bucket, { prefix: indexPrefix(prefix, slug) })).flatMap((pg) => pg.objects)
    .map((o) => parseIndexKey(prefix, slug, o.key)).filter(Boolean) as { day: string; id: string }[];
  const wanted = new Set(idx.map((s) => s.id));
  const days = [...new Set(idx.map((s) => s.day))].sort().reverse().slice(0, MAX_ALBUM_DAYS);
  const sessions = (await Promise.all(days.map(async (day) => {
    const objects = (await listAll(bucket, { prefix: `${prefix}${day}/`, include: ["customMetadata"] })).flatMap((pg) => pg.objects);
    const byKey = new Map(objects.map((o) => [o.key, o]));
    return groupSessions(prefix, objects.map((o) => o.key)).filter((s) => wanted.has(s.id)).map((s) => {
      const metaObj = s.files["meta.json"] ? byKey.get(s.files["meta.json"]) : undefined;
      let meta: Record<string, unknown> | null = null;
      try { meta = metaObj?.customMetadata?.meta ? JSON.parse(metaObj.customMetadata.meta) : null; } catch {}
      const files = Object.fromEntries(Object.entries(s.files).filter(([n]) => n !== "meta.json"));
      // Only what a guest needs: no user agent, face counts or booth internals.
      const pub = meta ? { capturedAt: meta.capturedAt, theme: meta.theme, shots: meta.shots, printed: meta.printed, ticket: meta.ticket } : null;
      return { id: s.id, day: s.day, files, meta: pub };
    });
  }))).flat();
  sessions.sort((a, b) => (idTime(b.id, Infinity) ?? 0) - (idTime(a.id, Infinity) ?? 0));
  return json(200, { event: publicEvent(event), sessions }, { "x-robots-tag": "noindex" });
}
