// /api/archive + /api/photos against an in-memory R2 stand-in (PIN is checked
// by src/index.ts before these routes run).
import test from "node:test";
import assert from "node:assert/strict";
import { handleArchive } from "../src/archive-api.ts";
import { newSessionId } from "../public/archive.js";

/** Just enough of R2Bucket for the archive routes. */
function memR2() {
  const objs = new Map();
  const obj = (key, o) => ({ key, size: o.data.byteLength, httpEtag: '"e"', httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
  return {
    objs,
    async put(key, data, opts = {}) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      objs.set(key, { data: bytes, httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata });
    },
    async get(key) {
      const o = objs.get(key);
      if (!o) return null;
      return { ...obj(key, o), body: new Blob([o.data]).stream(), json: async () => JSON.parse(new TextDecoder().decode(o.data)) };
    },
    async list({ prefix = "", delimiter, cursor, include }) {
      const keys = [...objs.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0, page = keys.slice(start, start + 2);   // tiny pages: exercises paging
      const truncated = start + 2 < keys.length;
      if (delimiter) {
        const prefixes = new Set(), objects = [];
        for (const k of keys) {
          const rest = k.slice(prefix.length), i = rest.indexOf(delimiter);
          if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1)); else objects.push(obj(k, objs.get(k)));
        }
        return { objects, delimitedPrefixes: [...prefixes], truncated: false };
      }
      return { objects: page.map((k) => ({ ...obj(k, objs.get(k)), customMetadata: include ? objs.get(k).customMetadata : undefined })),
        delimitedPrefixes: [], truncated, cursor: truncated ? String(start + 2) : undefined };
    },
  };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const T = Date.UTC(2026, 10, 15, 3, 30);   // 22:30 on 2026-11-14 in New York
const ID = newSessionId(T, new Uint8Array([1, 2, 3, 4]));

async function call(env, method, path, form) {
  const url = new URL("https://booth.test" + path);
  let req = new Request(url, { method, body: form });
  if (form) {   // undici's FormData Request has no content-length header; add it like a browser would
    const buf = await req.arrayBuffer();
    req = new Request(url, { method, body: buf, headers: { "content-type": req.headers.get("content-type"), "content-length": String(buf.byteLength) } });
  }
  const res = await handleArchive(req, url, env);
  return { res, body: res && res.headers.get("content-type") === "application/json" ? await res.json() : null };
}
function upload(meta, files = {}) {
  const f = new FormData();
  f.append("meta", JSON.stringify(meta));
  for (const [name, [bytes, type]] of Object.entries(files)) f.append(name, new Blob([bytes], { type }), name);
  return f;
}

test("upload originals, then strip; meta merges; list + fetch back", async () => {
  const env = { PHOTOS: memR2(), ARCHIVE_PREFIX: "staging/" };
  let r = await call(env, "POST", "/api/archive", upload({ id: ID, theme: "dino", shots: 2, printed: false },
    { "orig-1.jpg": [JPEG, "image/jpeg"], "orig-2.jpg": [JPEG, "image/jpeg"] }));
  assert.equal(r.res.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.day, "2026-11-14");
  assert.ok(env.PHOTOS.objs.has(`staging/2026-11-14/${ID}/orig-1.jpg`));

  r = await call(env, "POST", "/api/archive", upload({ id: ID, printed: true, copies: 2 }, { "strip.png": [PNG, "image/png"] }));
  assert.equal(r.res.status, 201);
  assert.deepEqual(r.body.files, ["orig-1.jpg", "orig-2.jpg", "strip.png"]);

  // Re-upload (retry) is idempotent and can't un-print.
  r = await call(env, "POST", "/api/archive", upload({ id: ID, printed: false }, { "orig-1.jpg": [JPEG, "image/jpeg"] }));
  assert.equal(r.body.printed, true);

  r = await call(env, "GET", "/api/photos?day=2026-11-14");
  assert.equal(r.body.sessions.length, 1);
  const s = r.body.sessions[0];
  assert.equal(s.meta.theme, "dino");
  assert.equal(s.meta.copies, 2);
  assert.deepEqual(s.meta.bytes, { "orig-1.jpg": 10, "orig-2.jpg": 10, "strip.png": 10 });
  assert.equal(s.sizes["strip.png"], PNG.length);

  r = await call(env, "GET", "/api/photos/file?key=" + encodeURIComponent(s.files["strip.png"]));
  assert.equal(r.res.status, 200);
  assert.equal(r.res.headers.get("content-type"), "image/png");
  assert.match(r.res.headers.get("cache-control"), /private/);
  assert.deepEqual(new Uint8Array(await r.res.arrayBuffer()), PNG);

  r = await call(env, "GET", "/api/photos/days");
  assert.deepEqual(r.body.days, [{ day: "2026-11-14", sessions: 1 }]);
});

test("rejects bad ids, names, types, content and traversal keys", async () => {
  const env = { PHOTOS: memR2(), ARCHIVE_PREFIX: "" };
  const bad = async (form, status, error) => {
    const r = await call(env, "POST", "/api/archive", form);
    assert.equal(r.res.status, status, error); assert.equal(r.body.error, error);
  };
  await bad(upload({ id: "../../x" }), 400, "invalid_id");
  await bad(upload({ id: ID }, { "../evil.jpg": [JPEG, "image/jpeg"] }), 400, "invalid_file_name");
  await bad(upload({ id: ID }, { "index.html": [JPEG, "text/html"] }), 400, "invalid_file_name");
  await bad(upload({ id: ID }, { "orig-1.jpg": [JPEG, "image/png"] }), 415, "invalid_content_type");
  await bad(upload({ id: ID }, { "orig-1.jpg": [PNG, "image/jpeg"] }), 415, "invalid_content");
  assert.equal(env.PHOTOS.objs.size, 0, "nothing written for rejected uploads");

  for (const key of ["../x", `2026-11-14/${ID}/../../secret`, "staging/2026-11-14/" + ID + "/orig-1.jpg", "jobs/a.bin"]) {
    const r = await call(env, "GET", "/api/photos/file?key=" + encodeURIComponent(key));
    assert.equal(r.res.status, 400, key);
  }
  assert.equal((await call(env, "GET", "/api/photos?day=../../")).res.status, 400);
});

test("size caps and disabled archive", async () => {
  const env = { PHOTOS: memR2(), ARCHIVE_PREFIX: "" };
  const url = new URL("https://booth.test/api/archive");
  const big = await handleArchive(new Request(url, { method: "POST", body: "x",
    headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(13 * 1024 * 1024) } }), url, env);
  assert.equal(big.status, 413);
  const huge = new Uint8Array(8 * 1024 * 1024 + 1); huge.set(JPEG);
  const r = await call(env, "POST", "/api/archive", upload({ id: ID }, { "orig-1.jpg": [huge, "image/jpeg"] }));
  assert.equal(r.res.status, 413);
  assert.equal((await call({}, "GET", "/api/photos/days")).res.status, 503);
  assert.equal(await handleArchive(new Request("https://booth.test/api/print"), new URL("https://booth.test/api/print"), env), null);
});
