// Events + public albums against an in-memory R2 stand-in.
import test from "node:test";
import assert from "node:assert/strict";
import { handleAlbum, handleEvents } from "../src/events-api.ts";
import { handleArchive } from "../src/archive-api.ts";
import { cleanEventInput, newToken, slugify, TOKEN_RE } from "../src/events.ts";
import { newSessionId } from "../public/archive.js";
import { qrMatrix } from "../public/qr.js";

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

async function call(env, method, path, body, handler = handleEvents) {
  const url = new URL("https://booth.test" + path);
  let req;
  if (body instanceof FormData) {
    const tmp = new Request(url, { method, body });
    const buf = await tmp.arrayBuffer();
    req = new Request(url, { method, body: buf, headers: { "content-type": tmp.headers.get("content-type"), "content-length": String(buf.byteLength) } });
  } else {
    req = new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
  }
  const res = await handler(req, url, env);
  return { res, body: res && res.headers.get("content-type") === "application/json" ? await res.json() : null };
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const T = Date.now() - 3600e3;   // ids must not be in the future
const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(T);
function form(meta, files) {
  const f = new FormData();
  f.append("meta", JSON.stringify(meta));
  for (const [name, [bytes, type]] of Object.entries(files)) f.append(name, new Blob([bytes], { type }), name);
  return f;
}

test("slugify, tokens, input validation", () => {
  assert.equal(slugify("Thanksgiving 2026!"), "thanksgiving-2026");
  assert.equal(slugify("🦃🦃"), "party");
  assert.equal(slugify("Crème brûlée night"), "creme-brulee-night");
  for (let i = 0; i < 50; i++) assert.match(newToken(), TOKEN_RE);
  assert.deepEqual(cleanEventInput({}), { ok: false, error: "invalid_name" });
  assert.equal(cleanEventInput({ name: "x", date: "2026-02-30" }).error, "invalid_date");
  assert.equal(cleanEventInput({ name: "x", themes: ["../x"] }).error, "invalid_themes");
  assert.equal(cleanEventInput({ name: "x", themes: ["turkey"], theme: "dino" }).error, "theme_not_offered");
  const ok = cleanEventInput({ name: "  TG \n", themes: ["turkey", "turkey", "feast"], theme: "feast", footer: "x".repeat(99) });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.themes, ["turkey", "feast"]);
  assert.equal(ok.value.name, "TG");
  assert.equal(ok.value.footer.length, 40);
  assert.equal(ok.value.qr, true);
});

test("qr encoder: per-session strip link fits a small code", () => {
  const { n, dark } = qrMatrix("https://booth.receiptd.sh/a/abcdefghjkmn/mhz3k2a1-0f3a9c11");
  assert.ok(n <= 37, `version ≤ 5 (got ${n} modules)`);
  assert.equal(dark(0, 0), true);   // finder pattern corner
});

test("create → activate → shoot → album lists it → files gated by album", async () => {
  const env = { PHOTOS: memR2(), ARCHIVE_PREFIX: "staging/" };
  let r = await call(env, "POST", "/api/events", { name: "Thanksgiving 2026", date: "2026-11-26", themes: ["turkey", "feast", "leaves", "starry", "harvest"], theme: "turkey", footer: "Thanksgiving 2026" });
  assert.equal(r.res.status, 201, JSON.stringify(r.body));
  const ev = r.body.event;
  assert.equal(ev.slug, "thanksgiving-2026");
  assert.match(ev.share, TOKEN_RE);
  assert.ok(env.PHOTOS.objs.has("staging/events/thanksgiving-2026/event.json"));

  // Same name again → distinct slug.
  r = await call(env, "POST", "/api/events", { name: "Thanksgiving 2026" });
  assert.equal(r.body.event.slug, "thanksgiving-2026-2");

  assert.equal((await call(env, "GET", "/api/events/active")).body.event, null);
  r = await call(env, "POST", "/api/events/active", { slug: ev.slug });
  assert.equal(r.body.event.slug, ev.slug);
  assert.equal((await call(env, "GET", "/api/events/active")).body.event.share, ev.share);
  r = await call(env, "GET", "/api/events");
  assert.equal(r.body.events.length, 2);
  assert.equal(r.body.active, ev.slug);

  // Two booth sessions: one for the party, one not.
  const mine = newSessionId(T, new Uint8Array([1, 2, 3, 4]));
  const other = newSessionId(T + 60000, new Uint8Array([5, 6, 7, 8]));
  r = await call(env, "POST", "/api/archive", form({ id: mine, event: ev.slug, theme: "turkey", shots: 1, ua: "secret-ua" }, { "orig-1.jpg": [JPEG, "image/jpeg"] }), handleArchive);
  assert.equal(r.res.status, 201, JSON.stringify(r.body));
  await call(env, "POST", "/api/archive", form({ id: mine, event: ev.slug, printed: true }, { "strip.png": [PNG, "image/png"] }), handleArchive);
  await call(env, "POST", "/api/archive", form({ id: other, theme: "dino" }, { "orig-1.jpg": [JPEG, "image/jpeg"] }), handleArchive);

  r = await call(env, "GET", `/api/album/${ev.share}`, undefined, handleAlbum);
  assert.equal(r.res.status, 200);
  assert.equal(r.body.event.name, "Thanksgiving 2026");
  assert.equal(r.body.event.share, undefined, "album never echoes the token / booth config");
  assert.equal(r.body.sessions.length, 1);
  const s = r.body.sessions[0];
  assert.equal(s.id, mine);
  assert.deepEqual(Object.keys(s.files).sort(), ["orig-1.jpg", "strip.png"]);
  assert.equal(s.meta.theme, "turkey");
  assert.equal(s.meta.ua, undefined, "no user agent in the public album");

  r = await call(env, "GET", `/api/album/${ev.share}/file?key=${encodeURIComponent(s.files["orig-1.jpg"])}&dl=1`, undefined, handleAlbum);
  assert.equal(r.res.status, 200);
  assert.equal(r.res.headers.get("content-type"), "image/jpeg");
  assert.match(r.res.headers.get("content-disposition"), /^attachment; filename="thanksgiving-2026-\d{8}-\d{6}-orig-1\.jpg"$/);
  assert.deepEqual(new Uint8Array(await r.res.arrayBuffer()), JPEG);

  // A real archive key that isn't in this album → 404; meta.json / junk → 400; wrong token → 404.
  const otherKey = `staging/${DAY}/${other}/orig-1.jpg`;
  assert.ok(env.PHOTOS.objs.has(otherKey));
  assert.equal((await call(env, "GET", `/api/album/${ev.share}/file?key=${encodeURIComponent(otherKey)}`, undefined, handleAlbum)).res.status, 404);
  assert.equal((await call(env, "GET", `/api/album/${ev.share}/file?key=${encodeURIComponent(`staging/${DAY}/${mine}/meta.json`)}`, undefined, handleAlbum)).res.status, 400);
  assert.equal((await call(env, "GET", `/api/album/${ev.share}/file?key=../../x`, undefined, handleAlbum)).res.status, 400);
  assert.equal((await call(env, "GET", "/api/album/abcdefghjkmn", undefined, handleAlbum)).res.status, 404);
  assert.equal(await handleAlbum(new Request("https://booth.test/api/photos"), new URL("https://booth.test/api/photos"), env), null);

  // Attach a whole day pulls in the other session; detach hides it again.
  r = await call(env, "POST", `/api/events/${ev.slug}/attach`, { day: DAY });
  assert.equal(r.body.added, 2);
  assert.equal((await call(env, "GET", `/api/album/${ev.share}`, undefined, handleAlbum)).body.sessions.length, 2);
  await call(env, "POST", `/api/events/${ev.slug}/detach`, { day: DAY, id: other });
  assert.equal((await call(env, "GET", `/api/album/${ev.share}`, undefined, handleAlbum)).body.sessions.length, 1);

  // Rotating the share link kills the old one.
  r = await call(env, "POST", `/api/events/${ev.slug}/share`);
  const next = r.body.event.share;
  assert.notEqual(next, ev.share);
  assert.equal((await call(env, "GET", `/api/album/${ev.share}`, undefined, handleAlbum)).res.status, 404);
  assert.equal((await call(env, "GET", `/api/album/${next}`, undefined, handleAlbum)).res.status, 200);

  // Edit: narrowing themes re-picks a valid default; clearing the date removes it.
  r = await call(env, "PUT", `/api/events/${ev.slug}`, { themes: ["leaves"], date: "" });
  assert.equal(r.res.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.event.theme, "leaves");
  assert.equal(r.body.event.date, undefined);
  assert.equal(r.body.event.share, next);

  // Clearing the default ("None (= all)" on the party page) really clears it.
  r = await call(env, "PUT", `/api/events/${ev.slug}`, { themes: [], theme: null });
  assert.deepEqual(r.body.event.themes, []);
  assert.equal(r.body.event.theme, undefined);

  // Deactivate.
  await call(env, "POST", "/api/events/active", { slug: null });
  assert.equal((await call(env, "GET", "/api/events/active")).body.event, null);
  // Events never show up as archive days.
  const days = await call(env, "GET", "/api/photos/days", undefined, handleArchive);
  assert.deepEqual(days.body.days.map((d) => d.day), [DAY]);
});

test("bad routes and inputs", async () => {
  const env = { PHOTOS: memR2(), ARCHIVE_PREFIX: "" };
  assert.equal((await call(env, "POST", "/api/events", { name: "" })).res.status, 400);
  assert.equal((await call(env, "GET", "/api/events/nope")).res.status, 404);
  assert.equal((await call(env, "POST", "/api/events/active", { slug: "nope" })).res.status, 404);
  assert.equal((await call(env, "POST", "/api/events/active", { slug: "../x" })).res.status, 400);
  const { body } = await call(env, "POST", "/api/events", { name: "x" });
  assert.equal((await call(env, "POST", `/api/events/${body.event.slug}/attach`, { day: "nope" })).res.status, 400);
  assert.equal((await call(env, "POST", `/api/events/${body.event.slug}/attach`, { day: "2026-11-26", ids: ["../x"] })).res.status, 400);
  assert.equal((await call({}, "GET", "/api/events")).res.status, 503);
  assert.equal(await handleEvents(new Request("https://booth.test/api/eventsx"), new URL("https://booth.test/api/eventsx"), env), null);
});
