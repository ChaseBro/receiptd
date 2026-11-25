// "Your photos" links (/s/<token>) against an in-memory R2 stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { handleSessionShare, handleSessionShareCreate, SESSION_SHARE_TTL_S } from "../src/session-share.ts";
import { handleArchive } from "../src/archive-api.ts";
import { handleEvents } from "../src/events-api.ts";
import { TOKEN_RE } from "../src/events.ts";
import { newSessionId } from "../public/archive.js";

function memR2() {
  const objs = new Map();
  const meta = (key, o) => ({ key, size: o.data.byteLength, httpEtag: '"e"', httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
  return {
    objs,
    async put(key, data, opts = {}) {
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      objs.set(key, { data: bytes, httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata });
    },
    async head(key) { const o = objs.get(key); return o ? meta(key, o) : null; },
    async delete(key) { objs.delete(key); },
    async get(key) {
      const o = objs.get(key);
      if (!o) return null;
      const text = () => new TextDecoder().decode(o.data);
      return { ...meta(key, o), body: new Blob([o.data]).stream(), text: async () => text(), json: async () => JSON.parse(text()) };
    },
    async list({ prefix = "", delimiter, include }) {
      const keys = [...objs.keys()].filter((k) => k.startsWith(prefix)).sort();
      if (delimiter) {
        const prefixes = new Set(), objects = [];
        for (const k of keys) {
          const rest = k.slice(prefix.length), i = rest.indexOf(delimiter);
          if (i >= 0) prefixes.add(prefix + rest.slice(0, i + 1)); else objects.push(meta(k, objs.get(k)));
        }
        return { objects, delimitedPrefixes: [...prefixes], truncated: false };
      }
      return { objects: keys.map((k) => ({ ...meta(k, objs.get(k)), customMetadata: include ? objs.get(k).customMetadata : undefined })), delimitedPrefixes: [], truncated: false };
    },
  };
}

async function call(env, method, path, body, handler, now) {
  const url = new URL("https://booth.test" + path);
  let req;
  if (body instanceof FormData) {
    const tmp = new Request(url, { method, body });
    const buf = await tmp.arrayBuffer();
    req = new Request(url, { method, body: buf, headers: { "content-type": tmp.headers.get("content-type"), "content-length": String(buf.byteLength) } });
  } else {
    req = new Request(url, { method, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
  }
  const res = await handler(req, url, env, ...(now ? [now] : []));
  return { res, body: res && res.headers.get("content-type") === "application/json" ? await res.json() : null };
}
const create = (env, id, body, now) => call(env, "POST", `/api/sessions/${id}/share`, body, handleSessionShareCreate, now);
const pub = (env, path, now) => call(env, "GET", path, undefined, handleSessionShare, now);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const T = Date.now() - 3600e3;
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(T);
function form(meta, files) {
  const f = new FormData();
  f.append("meta", JSON.stringify(meta));
  for (const [name, [bytes, type]] of Object.entries(files)) f.append(name, new Blob([bytes], { type }), name);
  return f;
}

test("share a session before it's uploaded → page waits → files appear → only that session's files", async () => {
  const env = { PHOTOS: memR2(), ARCHIVE_PREFIX: "staging/" };
  const mine = newSessionId(T, new Uint8Array([1, 2, 3, 4]));
  const other = newSessionId(T + 60000, new Uint8Array([5, 6, 7, 8]));

  let r = await create(env, mine);
  assert.equal(r.res.status, 201, JSON.stringify(r.body));
  const { token, url, expiresAt } = r.body;
  assert.match(token, TOKEN_RE);
  assert.equal(url, `https://booth.test/s/${token}`);
  const ttl = Date.parse(expiresAt) - Date.now();
  assert.ok(Math.abs(ttl - SESSION_SHARE_TTL_S * 1000) < 5000, "24 h by default");
  const stored = JSON.parse(new TextDecoder().decode(env.PHOTOS.objs.get(`staging/share-s/${token}`).data));
  assert.deepEqual(Object.keys(stored).sort(), ["day", "exp", "id"]);
  assert.equal(stored.day, DAY); assert.equal(stored.id, mine);

  // Nothing uploaded yet: the page gets an empty session (it shows "on its way…" and polls).
  r = await pub(env, `/api/s/${token}`);
  assert.equal(r.res.status, 200);
  assert.deepEqual(r.body.session.files, {});
  assert.equal(r.body.expiresAt, expiresAt);

  // The background upload lands (with party + booth internals in meta), plus another session.
  await call(env, "POST", "/api/archive", form({ id: mine, theme: "dino", shots: 1, ua: "secret-ua", event: "tg", faces: [2] }, { "orig-1.jpg": [JPEG, "image/jpeg"] }), handleArchive);
  await call(env, "POST", "/api/archive", form({ id: mine, printed: true }, { "strip.png": [PNG, "image/png"] }), handleArchive);
  await call(env, "POST", "/api/archive", form({ id: other, theme: "dino" }, { "orig-1.jpg": [JPEG, "image/jpeg"] }), handleArchive);

  r = await pub(env, `/api/s/${token}`);
  const s = r.body.session;
  assert.equal(s.id, mine);
  assert.deepEqual(Object.keys(s.files).sort(), ["orig-1.jpg", "strip.png"]);
  assert.deepEqual(Object.keys(s.meta).sort(), ["capturedAt", "printed", "shots", "theme"], "no ua / faces / event in public meta");
  assert.ok(!JSON.stringify(r.body).includes("secret-ua"));

  r = await pub(env, `/api/s/${token}/file?key=${encodeURIComponent(s.files["strip.png"])}&dl=1`);
  assert.equal(r.res.status, 200);
  assert.equal(r.res.headers.get("content-type"), "image/png");
  assert.match(r.res.headers.get("content-disposition"), /^attachment; filename="photobooth-\d{8}-\d{6}-strip\.png"$/);
  assert.deepEqual(new Uint8Array(await r.res.arrayBuffer()), PNG);

  // Another session's real key → 404; meta.json / traversal / other prefix → 400.
  const otherKey = `staging/${DAY}/${other}/orig-1.jpg`;
  assert.ok(env.PHOTOS.objs.has(otherKey));
  assert.equal((await pub(env, `/api/s/${token}/file?key=${encodeURIComponent(otherKey)}`)).res.status, 404);
  for (const key of [`staging/${DAY}/${mine}/meta.json`, "../../x", `${DAY}/${mine}/orig-1.jpg`, `staging/share-s/${token}`]) {
    assert.equal((await pub(env, `/api/s/${token}/file?key=${encodeURIComponent(key)}`)).res.status, 400, key);
  }
  // Wrong / malformed tokens; an album token is not a session token.
  assert.equal((await pub(env, "/api/s/abcdefghjkmn")).res.status, 404);
  assert.equal((await pub(env, "/api/s/" + encodeURIComponent("../../x"))).res.status, 404);
  assert.equal((await pub(env, "/api/s/ABCDEFGHJKMN")).res.status, 404);
  const ev = (await call(env, "POST", "/api/events", { name: "Party" }, handleEvents)).body.event;
  assert.equal((await pub(env, `/api/s/${ev.share}`)).res.status, 404);
  // Not GET → 405; other paths → null.
  assert.equal((await call(env, "POST", `/api/s/${token}`, undefined, handleSessionShare)).res.status, 405);
  assert.equal(await handleSessionShare(new Request("https://booth.test/api/album/x"), new URL("https://booth.test/api/album/x"), env), null);
  assert.equal(await handleSessionShareCreate(new Request("https://booth.test/api/sessions/x"), new URL("https://booth.test/api/sessions/x"), env), null);
});

test("links expire: 404 after exp, record deleted", async () => {
  const env = { PHOTOS: memR2(), ARCHIVE_PREFIX: "" };
  const id = newSessionId(T, new Uint8Array([9, 9, 9, 9]));
  await call(env, "POST", "/api/archive", form({ id }, { "orig-1.jpg": [JPEG, "image/jpeg"] }), handleArchive);
  const now = Date.now();
  const { token, expiresAt } = (await create(env, id, { ttl: 60 }, now)).body;
  assert.equal(Date.parse(expiresAt), now + 60000);
  const key = `${DAY}/${id}/orig-1.jpg`;
  assert.equal((await pub(env, `/api/s/${token}`, now + 59000)).res.status, 200);
  assert.equal((await pub(env, `/api/s/${token}/file?key=${encodeURIComponent(key)}`, now + 59000)).res.status, 200);
  assert.equal((await pub(env, `/api/s/${token}/file?key=${encodeURIComponent(key)}`, now + 60000)).res.status, 404);
  assert.equal((await pub(env, `/api/s/${token}`, now + 60000)).res.status, 404);
  assert.ok(!env.PHOTOS.objs.has(`share-s/${token}`), "expired record cleaned up");
  assert.ok(env.PHOTOS.objs.has(key), "the photos themselves stay in the archive");
});

test("create: validation", async () => {
  const env = { PHOTOS: memR2(), ARCHIVE_PREFIX: "" };
  const id = newSessionId(T, new Uint8Array([1, 1, 1, 1]));
  for (const bad of ["nope", "MHZ3K2A1-0F3A9C11", newSessionId(Date.now() + 3 * 86400e3, new Uint8Array(4)), encodeURIComponent(`${id}/../x`)]) {
    const r = await create(env, bad);
    assert.equal(r.res.status, 400, bad); assert.equal(r.body.error, "invalid_id");
  }
  assert.equal((await create(env, "../x")).res, null, "dot segments never reach the route");
  assert.equal((await create(env, id, { ttl: 0 })).body.error, "invalid_ttl");
  assert.equal((await create(env, id, { ttl: 8 * 86400 })).body.error, "invalid_ttl");
  assert.equal((await create(env, id, { ttl: "60" })).body.error, "invalid_ttl");
  assert.equal((await create(env, id, "{nope")).body.error, "invalid_body");
  assert.equal((await call(env, "GET", `/api/sessions/${id}/share`, undefined, handleSessionShareCreate)).res.status, 405);
  assert.equal((await create({}, id)).res.status, 503);
  assert.equal((await create({ PHOTOS: memR2(), ARCHIVE_PREFIX: "../" }, id)).res.status, 503);
  assert.equal(env.PHOTOS.objs.size, 0, "nothing stored for rejected requests");
  // Two shares of one session → two independent tokens.
  const a = (await create(env, id)).body.token, b = (await create(env, id)).body.token;
  assert.notEqual(a, b);
});
