// Photo archive routes (PIN already checked by the caller):
//
//   POST /api/archive            multipart: meta (JSON) + orig-N.jpg… + strip.png?
//   GET  /api/photos/days        → { days: [{ day, sessions }] }
//   GET  /api/photos?day=…       → { day, sessions: [{ id, meta, files, sizes }] }
//   GET  /api/photos/file?key=…  → the object (key must be under ARCHIVE_PREFIX)
//
// The bucket is private: nothing here hands out public or signed URLs, and
// image bytes / keys never go to console.log.

import {
  MAX_ARCHIVE_FILE, MAX_ARCHIVE_REQUEST, UPLOAD_RE,
  archiveKey, compactMeta, contentTypeFor, groupSessions, idTime, isDay, mergeMeta, nyDay,
  parseArchiveKey, sanitizeMeta, sniffOK, validPrefix, type ArchiveMeta,
} from "./archive.ts";

interface ArchiveEnv {
  PHOTOS?: R2Bucket;
  ARCHIVE_PREFIX?: string;
}

const MAX_FILES = 10;
const MAX_DAYS_COUNTED = 60;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Returns a Response for archive routes, or null if the path isn't one. */
export async function handleArchive(req: Request, url: URL, env: ArchiveEnv): Promise<Response | null> {
  const p = url.pathname;
  if (p !== "/api/archive" && p !== "/api/photos" && !p.startsWith("/api/photos/")) return null;
  const prefix = env.ARCHIVE_PREFIX ?? "";
  if (!env.PHOTOS || !validPrefix(prefix)) return json(503, { error: "archive_disabled" });
  const bucket = env.PHOTOS;

  if (p === "/api/archive" && req.method === "POST") return upload(req, bucket, prefix);
  if (req.method !== "GET") return json(405, { error: "method_not_allowed" });
  if (p === "/api/photos/days") return days(bucket, prefix);
  if (p === "/api/photos") {
    const day = url.searchParams.get("day");
    if (!isDay(day)) return json(400, { error: "invalid_day" });
    return sessions(bucket, prefix, day);
  }
  if (p === "/api/photos/file") {
    const key = url.searchParams.get("key");
    if (!parseArchiveKey(prefix, key)) return json(400, { error: "invalid_key" });
    const obj = await bucket.get(key!);
    if (!obj) return json(404, { error: "not_found" });
    const h = new Headers({
      "content-type": obj.httpMetadata?.contentType ?? contentTypeFor(key!),
      "content-length": String(obj.size),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      etag: obj.httpEtag,
    });
    return new Response(obj.body, { headers: h });
  }
  return json(404, { error: "not_found" });
}

async function upload(req: Request, bucket: R2Bucket, prefix: string): Promise<Response> {
  if (!(req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) return json(415, { error: "multipart_required" });
  const len = req.headers.get("content-length");
  if (len === null) return json(411, { error: "length_required" });
  if (!(Number(len) <= MAX_ARCHIVE_REQUEST)) return json(413, { error: "too_large" });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "invalid_body" });
  }
  const metaRaw = form.get("meta");
  if (typeof metaRaw !== "string" || metaRaw.length > 4000) return json(400, { error: "invalid_meta" });
  let parsed: { id?: unknown };
  try {
    parsed = JSON.parse(metaRaw);
  } catch {
    return json(400, { error: "invalid_meta" });
  }
  const id = typeof parsed?.id === "string" ? parsed.id : "";
  const t = idTime(id);
  if (t === null) return json(400, { error: "invalid_id" });
  const day = nyDay(t);
  const meta = sanitizeMeta(parsed, id, t);

  // Validate every file before writing any.
  const files: { name: string; data: ArrayBuffer }[] = [];
  for (const [name, value] of form.entries()) {
    if (name === "meta") continue;
    if (typeof value === "string" || !UPLOAD_RE.test(name)) return json(400, { error: "invalid_file_name" });
    if (files.some((f) => f.name === name)) return json(400, { error: "duplicate_file" });
    if (files.length >= MAX_FILES) return json(400, { error: "too_many_files" });
    if (value.size < 8 || value.size > MAX_ARCHIVE_FILE) return json(413, { error: "file_size" });
    if (value.type !== contentTypeFor(name)) return json(415, { error: "invalid_content_type" });
    const data = await value.arrayBuffer();
    if (!sniffOK(name, new Uint8Array(data, 0, 8))) return json(415, { error: "invalid_content" });
    files.push({ name, data });
  }

  // Overwrite = idempotent re-upload (e.g. re-rotated originals, retries).
  await Promise.all(files.map((f) => bucket.put(archiveKey(prefix, day, id, f.name), f.data, {
    httpMetadata: { contentType: contentTypeFor(f.name) },
  })));

  // Read-modify-write of meta.json. One booth uploads a session's parts
  // sequentially, so there's no concurrent writer for the same id.
  const metaKey = archiveKey(prefix, day, id, "meta.json");
  const prev = await bucket.get(metaKey);
  let old: Partial<ArchiveMeta> | null = null;
  if (prev) {
    try { old = await prev.json(); } catch { old = null; }
  }
  const merged = mergeMeta(old, meta, Object.fromEntries(files.map((f) => [f.name, f.data.byteLength])), new Date().toISOString());
  const compact = compactMeta(merged);
  await bucket.put(metaKey, JSON.stringify(merged, null, 2), {
    httpMetadata: { contentType: "application/json" },
    ...(compact ? { customMetadata: { meta: compact } } : {}),
  });
  return json(201, { ok: true, id, day, files: merged.files, printed: merged.printed });
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

async function sessions(bucket: R2Bucket, prefix: string, day: string): Promise<Response> {
  const pages = await listAll(bucket, { prefix: `${prefix}${day}/`, include: ["customMetadata"] });
  const objects = pages.flatMap((p) => p.objects);
  const byKey = new Map(objects.map((o) => [o.key, o]));
  const out = groupSessions(prefix, objects.map((o) => o.key)).map((s) => {
    const metaObj = s.files["meta.json"] ? byKey.get(s.files["meta.json"]) : undefined;
    let meta: unknown = null;
    try { meta = metaObj?.customMetadata?.meta ? JSON.parse(metaObj.customMetadata.meta) : null; } catch {}
    const sizes: Record<string, number> = {};
    for (const [name, key] of Object.entries(s.files)) sizes[name] = byKey.get(key)?.size ?? 0;
    return { ...s, meta, sizes };
  });
  return json(200, { day, sessions: out });
}

async function days(bucket: R2Bucket, prefix: string): Promise<Response> {
  const pages = await listAll(bucket, { prefix, delimiter: "/" });
  const list = pages.flatMap((p) => p.delimitedPrefixes)
    .map((d) => d.slice(prefix.length).replace(/\/$/, ""))
    .filter(isDay)
    .sort()
    .reverse();
  const counted = await Promise.all(list.map(async (day, i) => {
    if (i >= MAX_DAYS_COUNTED) return { day, sessions: null };
    const ps = await listAll(bucket, { prefix: `${prefix}${day}/`, delimiter: "/" });
    return { day, sessions: ps.reduce((n, p) => n + p.delimitedPrefixes.length, 0) };
  }));
  return json(200, { days: counted });
}
