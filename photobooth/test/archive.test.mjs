// Photo archive helpers: key building/validation, date bucketing, meta merge,
// the 1-bit PNG encoder and the STORE zip writer. (src/archive.ts runs via
// Node's built-in type stripping.)
import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import {
  archiveKey, compactMeta, groupSessions, idTime, isDay, mergeMeta, nyDay, parseArchiveKey,
  sanitizeMeta, sniffOK, validPrefix,
} from "../src/archive.ts";
import { crc32, encodeBitPNG, zipStore, zlibStored } from "../public/archive-codecs.js";
import { orderDue, backoffMs, fitSize, mergeQueuedMeta, newSessionId, pickDrops, planBatches } from "../public/archive.js";

const T = Date.UTC(2026, 10, 15, 3, 30);   // 2026-11-14 22:30 in New York
const ID = newSessionId(T, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));

test("session ids carry their capture time", () => {
  assert.match(ID, /^[0-9a-z]{8}-deadbeef$/);
  assert.equal(idTime(ID, T), T);
  assert.equal(idTime("nope", T), null);
  assert.equal(idTime("00000001-deadbeef", T), null, "before 2025");
  assert.equal(idTime(newSessionId(T + 3 * 86400e3), T), null, "far future");
  assert.equal(idTime(ID.toUpperCase(), T), null);
});

test("nyDay buckets by America/New_York, across DST", () => {
  assert.equal(nyDay(T), "2026-11-14");                          // 03:30 UTC is still the 14th in NY
  assert.equal(nyDay(Date.UTC(2026, 10, 15, 5, 0)), "2026-11-15"); // EST midnight = 05:00 UTC
  assert.equal(nyDay(Date.UTC(2026, 6, 4, 3, 59)), "2026-07-03");  // EDT: UTC-4
  assert.equal(nyDay(Date.UTC(2026, 6, 4, 4, 0)), "2026-07-04");
});

test("isDay / validPrefix", () => {
  assert.ok(isDay("2026-11-14"));
  for (const d of ["2026-02-30", "2026-1-14", "../x", "", null]) assert.ok(!isDay(d), String(d));
  assert.ok(validPrefix("") && validPrefix("staging/"));
  for (const p of ["/", "../", "staging", "a/b/", "Staging/"]) assert.ok(!validPrefix(p), p);
});

test("archive keys: build, parse, reject traversal and other prefixes", () => {
  const k = archiveKey("staging/", "2026-11-14", ID, "orig-1.jpg");
  assert.equal(k, `staging/2026-11-14/${ID}/orig-1.jpg`);
  assert.deepEqual(parseArchiveKey("staging/", k), { day: "2026-11-14", id: ID, name: "orig-1.jpg" });
  assert.equal(parseArchiveKey("", k), null, "prod can't read staging keys");
  for (const bad of [
    `staging/2026-11-14/${ID}/../../x.jpg`, `staging/../2026-11-14/${ID}/orig-1.jpg`,
    `staging/2026-11-14/${ID}/orig-0.jpg`, `staging/2026-11-14/${ID}/evil.html`,
    `staging/2026-11-14/${ID}/sub/orig-1.jpg`, `jobs/x.bin`, 42, null,
  ]) assert.equal(parseArchiveKey("staging/", bad), null, String(bad));
  assert.throws(() => archiveKey("", "2026-11-14", ID, "../x"));
  assert.throws(() => archiveKey("", "2026-11-14", "x/y", "strip.png"));
});

test("sniffOK checks magic bytes", () => {
  assert.ok(sniffOK("orig-1.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])));
  assert.ok(!sniffOK("orig-1.jpg", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])));
  assert.ok(sniffOK("strip.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.ok(!sniffOK("strip.png", new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0, 0, 0])));
});

test("sanitizeMeta whitelists and bounds fields", () => {
  const m = sanitizeMeta({ id: "x", capturedAt: "2026-11-14T22:30:00-05:00", theme: "dino", shots: 3, faces: [2, null, "x"],
    rotations: [0, 90, 0], copies: 2, printed: true, ua: "a".repeat(999), evil: "<script>", bytes: { "x": 1 } }, ID, T);
  assert.equal(m.id, ID);
  assert.equal(m.capturedAt, "2026-11-15T03:30:00.000Z");
  assert.deepEqual(m.faces, [2, null, null]);
  assert.equal(m.ua.length, 300);
  assert.equal(m.evil, undefined);
  assert.equal(m.bytes, undefined, "sizes come from the server, not the client");
  const d = sanitizeMeta({ theme: "../x", shots: 99, rotations: [45], copies: 9, printed: "yes" }, ID, T);
  assert.deepEqual(d, { id: ID, capturedAt: new Date(T).toISOString(), printed: false });
});

test("mergeMeta: printed is sticky, files/bytes accumulate, first timestamps kept", () => {
  const first = mergeMeta(null, { id: ID, capturedAt: "c", printed: false, rotations: [0] }, { "orig-1.jpg": 300000 }, "t1");
  assert.deepEqual(first.files, ["orig-1.jpg"]);
  assert.equal(first.printed, false);
  assert.equal(first.printedAt, undefined);
  const printed = mergeMeta(first, { id: ID, capturedAt: "c", printed: true, copies: 3 }, { "strip.png": 20000 }, "t2");
  assert.equal(printed.printed, true);
  assert.equal(printed.copies, 3);
  assert.equal(printed.printedAt, "t2");
  assert.equal(printed.createdAt, "t1");
  assert.deepEqual(printed.files, ["orig-1.jpg", "strip.png"]);
  assert.deepEqual(printed.bytes, { "orig-1.jpg": 300000, "strip.png": 20000 });
  // Re-rotated originals arrive later with printed:false — must not un-print.
  const rerot = mergeMeta(printed, { id: ID, capturedAt: "c", printed: false, rotations: [90] }, { "orig-1.jpg": 310000 }, "t3");
  assert.equal(rerot.printed, true);
  assert.equal(rerot.copies, 3);
  assert.equal(rerot.printedAt, "t2");
  assert.deepEqual(rerot.rotations, [90]);
  assert.equal(rerot.bytes["orig-1.jpg"], 310000);
  assert.equal(rerot.updatedAt, "t3");
  // Idempotent: same upload twice → same content (but updatedAt).
  const again = mergeMeta(rerot, { id: ID, capturedAt: "c", printed: false, rotations: [90] }, { "orig-1.jpg": 310000 }, "t3");
  assert.deepEqual(again, rerot);
});

test("compactMeta fits R2 customMetadata, dropping ua if needed", () => {
  const m = mergeMeta(null, { id: ID, capturedAt: "c", printed: false, ua: "u".repeat(300) }, {}, "t");
  assert.ok(compactMeta(m).includes('"ua"'));
  const big = { ...m, ua: "u".repeat(300), faces: Array(9).fill(99), theme: "x".repeat(1500) };
  const c = compactMeta(big);
  assert.ok(c === null || !c.includes('"ua"'));
});

test("groupSessions groups keys by id, newest first, ignoring junk", () => {
  const older = newSessionId(T - 60000, new Uint8Array(4));
  const keys = [
    `2026-11-14/${older}/meta.json`, `2026-11-14/${ID}/orig-1.jpg`, `2026-11-14/${ID}/strip.png`,
    `staging/2026-11-14/${ID}/orig-2.jpg`, `2026-11-14/${ID}/x.txt`,
  ];
  const g = groupSessions("", keys);
  assert.deepEqual(g.map((s) => s.id), [ID, older]);
  assert.deepEqual(Object.keys(g[0].files).sort(), ["orig-1.jpg", "strip.png"]);
});

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

/** Decode our 1-bit PNG back to { w, h, bits } (1 = black) with node:zlib. */
function decodeBitPNG(png) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let o = 8, w, h, idat = [];
  while (o < png.length) {
    const len = dv.getUint32(o), type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const body = png.subarray(o + 8, o + 8 + len);
    assert.equal(dv.getUint32(o + 8 + len), crc32(png.subarray(o + 4, o + 8 + len)), `${type} crc`);
    if (type === "IHDR") {
      w = dv.getUint32(o + 8); h = dv.getUint32(o + 12);
      assert.deepEqual([...body.subarray(8)], [1, 0, 0, 0, 0], "1-bit greyscale, no interlace");
    }
    if (type === "IDAT") idat.push(body);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)), rb = Math.ceil(w / 8), bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (rb + 1)], 0, "filter None");
    for (let x = 0; x < w; x++) bits[y * w + x] = (raw[y * (rb + 1) + 1 + (x >> 3)] >> (7 - (x & 7))) & 1 ? 0 : 1;
  }
  return { w, h, bits };
}

test("encodeBitPNG round-trips a 1-bit bitmap (black = 1), small", async () => {
  const w = 576, h = 1800, bits = new Uint8Array(w * h);
  for (let i = 0; i < bits.length; i++) bits[i] = ((i * 2654435761) >>> 28) & 1 && (i % w) < 300 ? 1 : 0;
  for (let x = 0; x < w; x++) bits[x] = 1;                  // a solid black first row
  const png = await encodeBitPNG(bits, w, h);
  const back = decodeBitPNG(png);
  assert.equal(back.w, w); assert.equal(back.h, h);
  assert.deepEqual(back.bits, bits);
  assert.ok(png.length < (w / 8) * h, `compressed: ${png.length} bytes`);
});

test("encodeBitPNG odd widths + stored-deflate fallback decode identically", async () => {
  const w = 13, h = 70001 >> 6, bits = new Uint8Array(w * h).map((_, i) => (i * 7) % 3 === 0 ? 1 : 0);
  const viaStored = await encodeBitPNG(bits, w, h, async (b) => zlibStored(b));
  assert.deepEqual(decodeBitPNG(viaStored).bits, bits);
  // Stored blocks split at 65535 bytes.
  const big = new Uint8Array(150000).map((_, i) => i & 0xff);
  assert.deepEqual(new Uint8Array(inflateSync(zlibStored(big))), big);
  assert.deepEqual(new Uint8Array(inflateSync(zlibStored(new Uint8Array(0)))), new Uint8Array(0));
});

test("zipStore writes a valid STORE zip (local headers, central dir, EOCD)", () => {
  const enc = new TextEncoder();
  const files = [
    { name: "cheese-2026-11-14/223000-x/orig-1.jpg", data: enc.encode("jpeg bytes"), date: new Date(2026, 10, 14, 22, 30, 0) },
    { name: "cheese-2026-11-14/223000-x/strip.png", data: new Uint8Array(1000).fill(7) },
  ];
  const parts = zipStore(files);
  const zip = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { zip.set(p, o); o += p.length; }
  const dv = new DataView(zip.buffer);
  const eocd = zip.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  assert.equal(dv.getUint16(eocd + 10, true), 2);
  let cd = dv.getUint32(eocd + 16, true);
  for (const f of files) {
    assert.equal(dv.getUint32(cd, true), 0x02014b50);
    assert.equal(dv.getUint16(cd + 10, true), 0, "STORE");
    const nameLen = dv.getUint16(cd + 28, true), off = dv.getUint32(cd + 42, true);
    assert.equal(new TextDecoder().decode(zip.subarray(cd + 46, cd + 46 + nameLen)), f.name);
    assert.equal(dv.getUint32(cd + 16, true), crc32(f.data));
    assert.equal(dv.getUint32(off, true), 0x04034b50);
    const dataAt = off + 30 + dv.getUint16(off + 26, true);
    assert.deepEqual(zip.subarray(dataAt, dataAt + f.data.length), f.data);
    cd += 46 + nameLen;
  }
  const t = dv.getUint16(10, true), d = dv.getUint16(12, true);
  assert.equal(t, (22 << 11) | (30 << 5));
  assert.equal(d, ((2026 - 1980) << 9) | (11 << 5) | 14);
});

test("client queue helpers: batches, drops, backoff, meta merge, downscale", () => {
  assert.deepEqual(planBatches([]), [[]], "meta-only upload");
  assert.deepEqual(planBatches([{ name: "a", bytes: 6 }, { name: "b", bytes: 5 }, { name: "c", bytes: 4 }], 10), [["a"], ["b", "c"]]);
  assert.deepEqual(planBatches([{ name: "huge", bytes: 50 }, { name: "b", bytes: 1 }], 10), [["huge"], ["b"]]);
  const recs = [{ id: "new", createdAt: 3, bytes: 100 }, { id: "old", createdAt: 1, bytes: 100 }, { id: "mid", createdAt: 2, bytes: 100 }];
  assert.deepEqual(pickDrops(recs, 300), []);
  assert.deepEqual(pickDrops(recs, 150), ["old", "mid"]);
  assert.equal(backoffMs(1), 5000); assert.equal(backoffMs(3), 20000); assert.equal(backoffMs(30), 600000);
  const m = mergeQueuedMeta({ printed: true, copies: 2, bytes: { a: 1 } }, { printed: false, rotations: [90], bytes: { b: 2 } });
  assert.equal(m.printed, true); assert.equal(m.copies, 2); assert.deepEqual(m.bytes, { a: 1, b: 2 });
  assert.deepEqual(fitSize(1920, 1440), [1920, 1440], "never upscales");
  assert.deepEqual(fitSize(4032, 3024), [2048, 1536]);
  assert.deepEqual(fitSize(3024, 4032), [1536, 2048]);
});

test("orderDue: the shared session jumps the queue (even out of a backoff), then oldest first", () => {
  const now = 1000;
  const recs = [
    { id: "b", createdAt: 2, nextAt: 0 },
    { id: "a", createdAt: 1, nextAt: 0 },
    { id: "late", createdAt: 0, nextAt: 5000 },   // backing off
    { id: "mine", createdAt: 9, nextAt: 9999 },   // backing off, but being shared
  ];
  assert.deepEqual(orderDue(recs, null, now).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(orderDue(recs, "mine", now).map((r) => r.id), ["mine", "a", "b"]);
  assert.deepEqual(orderDue(recs, "b", now).map((r) => r.id), ["b", "a"]);
  assert.deepEqual(orderDue(recs, "gone", now).map((r) => r.id), ["a", "b"]);
});
