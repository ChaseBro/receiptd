// Parity fixtures: runs the web app's own public/frames.js + raster.js in
// WebKit (the engine iPad Safari uses; its canvas is CoreGraphics, like the
// native port) and writes what the Swift port must reproduce byte for byte.
//
//   node ios/parity/gen.mjs            (from photobooth/; Playwright WebKit)
//
// Writes
//   BoothCore/Sources/BoothCore/Resources/Stickers/<hex>-<size>.z
//       every emoji sticker's art canvas (S×S, S = ceil(size·1.7)) as
//       premultiplied BGRA, raw deflate. Colour-emoji bitmaps resample ±1 grey
//       level differently between CoreText's and WebKit's draw paths, so the
//       app draws these instead of the live glyph (live CoreText is the fallback).
//   BoothCore/Tests/BoothCoreTests/Fixtures/strips/   (gitignored, ~MBs)
//       manifest.json + per case: input frames, the composed RGBA strip (before
//       dithering), photo tiles, and the dithered bits for each copy.
//   BoothCore/Tests/BoothCoreTests/Fixtures/strips.sha256.json  (committed)
//       hashes of the same outputs, so a stale fixture set is noticed.
import { webkit } from "playwright";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { extname, join, normalize } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const PUBLIC = join(HERE, "../../public");
const CORE = join(HERE, "../BoothCore");
const STICKERS = join(CORE, "Sources/BoothCore/Resources/Stickers");
const OUT = join(CORE, "Tests/BoothCoreTests/Fixtures/strips");

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__parity.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><head><style>@font-face { font-family:"Lilita"; src:url("./fonts/lilita-one.woff2") format("woff2"); font-display:block; }</style></head><body style="font-family:Lilita">x</body></html>`);
  }
  const p = normalize(join(PUBLIC, url.pathname));
  if (!p.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try { const b = readFileSync(p); res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await webkit.launch();
const page = await (await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" })).newPage();
page.on("pageerror", (e) => console.error("pageerror", e.message));
await page.goto(base + "/__parity.html");

// Cases: every theme, 1 and 3 shots, both orientations, QR / footer / faces mixed in.
const THEMES = ["film", "stars", "hearts", "party", "dino", "space", "turkey", "feast", "leaves", "starry", "harvest", "plain"];
const cases = [];
THEMES.forEach((theme, i) => {
  cases.push({ name: `${theme}-3`, theme, frames: ["land", "port", "land"], seed: 1000 + i * 7919, ticket: 42 + i,
    footer: i % 3 === 0 ? "Thanksgiving 2026" : "", qr: i % 2 === 0 ? "https://booth.receiptd.sh/a/abcdefghjkmn/mfx3k2a1-1a2b3c4d" : "",
    faces: i % 4 === 1 ? [[{ x: 520, y: 260, w: 300, h: 360 }], [], [{ x: 100, y: 200, w: 260, h: 300 }, { x: 600, y: 300, w: 280, h: 320 }]] : null,
    copies: 2, sinkStart: i % 2 ? 0.3 : 0, gain: [0, 0.1, 0.15, 0.25, 0.4][i % 5] });
  cases.push({ name: `${theme}-1`, theme, frames: [i % 2 ? "port" : "land"], seed: 77 + i, ticket: 7 + i,
    footer: i % 2 ? "Brownell party · 2026" : "", qr: i % 3 === 1 ? "https://booth-staging.receiptd.sh/a/zzzzzzzzzzzz/abc-12345678" : "",
    faces: null, copies: 1, sinkStart: 0, gain: 0.15 });
});
// A 4-photo strip per sticker theme, so every emoji in the per-photo lists gets baked.
for (const theme of ["party", "dino", "space", "turkey", "feast", "leaves", "starry", "harvest"]) {
  cases.push({ name: `${theme}-4`, theme, frames: ["land", "land", "port", "land"], seed: 5, ticket: 1, footer: "", qr: "", faces: null, copies: 1, sinkStart: 0, gain: 0.15, stickersOnly: true });
}

const result = await page.evaluate(async (cases) => {
  await document.fonts.load("40px Lilita");
  const { compose, coverCrop, facesToTile } = await import("/frames.js");
  const { luminance, toneMap } = await import("/raster.js");
  const { ditherThermal, relieveSolids } = await import("/raster.js");
  const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };

  // Record every emoji sticker drawn (sticker() draws its art with fillText in the emoji stack).
  const seen = new Map();
  const origFill = OffscreenCanvasRenderingContext2D.prototype.fillText;
  OffscreenCanvasRenderingContext2D.prototype.fillText = function (t, x, y, ...rest) {
    if (this.font.includes("Apple Color Emoji") && this.textAlign === "center") seen.set(`${t}|${parseFloat(this.font)}`, [t, parseFloat(this.font)]);
    return origFill.call(this, t, x, y, ...rest);
  };

  // Deterministic synthetic camera frames: gradients, blobs, edges, noise.
  function frame(kind, seed) {
    const [w, h] = kind === "land" ? [1440, 1080] : [1080, 1350];
    const c = new OffscreenCanvas(w, h), x = c.getContext("2d", { willReadFrequently: true });
    let s = seed >>> 0 || 1; const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, "rgb(230,210,180)"); g.addColorStop(1, "rgb(40,60,90)");
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 14; i++) { x.fillStyle = `rgb(${(r() * 255) | 0},${(r() * 255) | 0},${(r() * 255) | 0})`; x.beginPath(); x.arc(r() * w, r() * h, 40 + r() * 220, 0, Math.PI * 2); x.fill(); }
    x.fillStyle = "rgb(20,20,25)"; x.fillRect(0, h * 0.8, w, h * 0.2);
    const img = x.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (r() - 0.5) * 24; d[i] += n; d[i + 1] += n; d[i + 2] += n; d[i + 3] = 255; }
    x.putImageData(img, 0, 0);
    return { canvas: c, rgba: new Uint8Array(x.getImageData(0, 0, w, h).data.buffer.slice(0)) };
  }
  const frameCache = {};
  const getFrame = (kind, i) => (frameCache[kind + i] ??= frame(kind, 1234 + i * 99 + (kind === "port" ? 7 : 0)));

  const date = new Date("2026-11-26T17:39:00-05:00");
  const out = [];
  for (const cs of cases) {
    const frames = cs.frames.map((k, i) => getFrame(k, i));
    const { canvas, layout } = compose(frames.map((f) => f.canvas), { theme: cs.theme, seed: cs.seed, footer: cs.footer, ticket: cs.ticket, date, faces: cs.faces ?? [], qr: cs.qr });
    if (cs.stickersOnly) continue;
    const H = layout.H, rgba = new Uint8Array(canvas.getContext("2d").getImageData(0, 0, 576, H).data.buffer.slice(0));
    const gray = luminance(rgba, 576, H);
    const segs = layout.qrSide
      ? [{ y0: 0, y1: layout.qrY, opts: { gain: cs.gain, bleed: 0 } }, { y0: layout.qrY, y1: H, opts: { gain: 0, bleed: 0, relief: 0 } }]
      : [{ y0: 0, y1: H, opts: { gain: cs.gain, bleed: 0 } }];
    // dither.worker.js, inline
    const baseBits = segs.map((s) => ditherThermal(gray.subarray(s.y0 * 576, s.y1 * 576), 576, s.y1 - s.y0, s.opts));
    const state = { sink: cs.sinkStart }, bits = [];
    for (let c = 0; c < cs.copies; c++) {
      const b = new Uint8Array(576 * H);
      segs.forEach((s, k) => { const rr = s.opts.relief ?? 1; b.set(rr ? relieveSolids(baseBits[k], 576, s.y1 - s.y0, { strength: rr, state }) : baseBits[k], s.y0 * 576); });
      bits.push(b64(b));
    }
    // photo tiles (toneMap) on their own, for the first photo
    const p0 = layout.photos[0];
    // every photo's tile, before (crop) and after (tone) toneMap
    const tiles = layout.photos.map((p, i) => {
      const crop = coverCrop(frames[i].canvas.width, frames[i].canvas.height, p.w, p.h);
      const tc = new OffscreenCanvas(p.w, p.h), tx = tc.getContext("2d", { willReadFrequently: true });
      tx.drawImage(frames[i].canvas, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, p.w, p.h);
      const tileRGBA = new Uint8Array(tx.getImageData(0, 0, p.w, p.h).data.buffer.slice(0));
      const tone = toneMap(luminance(tileRGBA, p.w, p.h), { width: p.w, height: p.h, faces: facesToTile(cs.faces?.[i], crop, p.w, p.h) });
      // putImageData of the tone-mapped tile, then the tilted draw onto paper (as compose)
      if (!["space-3", "hearts-3", "stars-3", "plain-1"].includes(cs.name)) return { w: p.w, h: p.h, x: p.x, rgba: b64(tileRGBA), tone: b64(new Uint8Array(tone.buffer)) };
      const img = tx.getImageData(0, 0, p.w, p.h);
      for (let k = 0, j = 0; j < tone.length; k += 4, j++) { img.data[k] = img.data[k + 1] = img.data[k + 2] = tone[j]; img.data[k + 3] = 255; }
      tx.putImageData(img, 0, 0);
      const put = new Uint8Array(tx.getImageData(0, 0, p.w, p.h).data.buffer.slice(0));
      const rc = new OffscreenCanvas(576, p.h + 60), rx = rc.getContext("2d", { willReadFrequently: true });
      rx.fillStyle = "#fff"; rx.fillRect(0, 0, 576, p.h + 60);
      const tilt = ((0.37 - 0.5) * 2 * 1.6 * Math.PI) / 180;
      rx.save(); rx.translate(p.x + p.w / 2, 30 + p.h / 2); rx.rotate(tilt); rx.drawImage(tc, -p.w / 2, -p.h / 2); rx.restore();
      const rot = new Uint8Array(rx.getImageData(0, 0, 576, p.h + 60).data.buffer.slice(0));
      return { w: p.w, h: p.h, x: p.x, rgba: b64(tileRGBA), tone: b64(new Uint8Array(tone.buffer)), put: b64(put), rot: b64(rot) };
    });
    out.push({ ...cs, layout, H, sinkEnd: state.sink, rgba: b64(rgba), bits, tiles,
      frameRGBA: cs.frames.map((k, i) => ({ key: k + i, w: frames[i].canvas.width, h: frames[i].canvas.height })),
      });
  }
  const frameData = Object.fromEntries(Object.entries(frameCache).map(([k, f]) => [k, { w: f.canvas.width, h: f.canvas.height, rgba: b64(f.rgba) }]));

  // Bake stickers: premultiplied colour = art over opaque black; alpha from the art itself.
  OffscreenCanvasRenderingContext2D.prototype.fillText = origFill;
  const EMOJI = `"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  // Each sticker as frames.js sticker() builds it: the art, then the white halo
  // and black shadow silhouettes. Those canvases are GPU-backed in WebKit (no
  // willReadFrequently), which rasterizes the 16 offset draws differently from
  // CPU CoreGraphics, so all three are baked.
  const premul = (canvas, S) => {   // premultiplied BGRA: colour = over opaque black, alpha as is
    const alpha = canvas.getContext("2d").getImageData(0, 0, S, S).data;
    const blk = new OffscreenCanvas(S, S), k = blk.getContext("2d", { willReadFrequently: true });
    k.fillStyle = "#000"; k.fillRect(0, 0, S, S); k.drawImage(canvas, 0, 0);
    const pm = k.getImageData(0, 0, S, S).data, bgra = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S * 4; i += 4) { bgra[i] = pm[i + 2]; bgra[i + 1] = pm[i + 1]; bgra[i + 2] = pm[i]; bgra[i + 3] = alpha[i + 3]; }
    return bgra;
  };
  const stickers = [...seen.values()].map(([emoji, size]) => {
    const S = Math.ceil(size * 1.7), o = Math.max(5, size * 0.09);
    const art = new OffscreenCanvas(S, S), a = art.getContext("2d");
    a.font = `${size}px ${EMOJI}`; a.textAlign = "center"; a.textBaseline = "middle"; a.fillText(emoji, S / 2, S / 2);
    const sil = (color, grow) => {
      const c = new OffscreenCanvas(S, S), h = c.getContext("2d");
      for (let k = 0; k < 16; k++) { const t = (Math.PI * 2 * k) / 16; h.drawImage(art, Math.cos(t) * grow, Math.sin(t) * grow); }
      h.globalCompositeOperation = "source-in"; h.fillStyle = color; h.fillRect(0, 0, S, S);
      return c;
    };
    const parts = [premul(art, S), premul(sil("#fff", o), S), premul(sil("#000", o + 3), S)];
    const all = new Uint8Array(S * S * 4 * 3); parts.forEach((p, i) => all.set(p, i * S * S * 4));
    return { emoji, size, S, bgra: b64(all) };
  });

  // One sticker's silhouettes on their own (sticker() internals).
  const silFix = (() => {
    const size = 96, S = Math.ceil(size * 1.7), o = Math.max(5, size * 0.09);
    const art = new OffscreenCanvas(S, S), a = art.getContext("2d");
    a.font = `${size}px ${EMOJI}`; a.textAlign = "center"; a.textBaseline = "middle"; a.fillText("🦕", S / 2, S / 2);
    const sil = (color, grow, fill = true) => {
      const c = new OffscreenCanvas(S, S), h = c.getContext("2d");   // as sticker(): no willReadFrequently
      for (let k = 0; k < 16; k++) { const t = (Math.PI * 2 * k) / 16; h.drawImage(art, Math.cos(t) * grow, Math.sin(t) * grow); }
      if (fill) { h.globalCompositeOperation = "source-in"; h.fillStyle = color; h.fillRect(0, 0, S, S); }
      return b64(new Uint8Array(h.getImageData(0, 0, S, S).data.buffer.slice(0)));
    };
    return { S, stack: sil("#fff", o, false), halo: sil("#fff", o), shadow: sil("#000", o + 3) };
  })();

  // Text on its own: one small canvas per item, as ticketStub / film / calibration draw it.
  const DISPLAY = `"Lilita", "Arial Rounded MT Bold", sans-serif`;
  const TEXT = [
    { s: "2026", size: 20, x: 54, y: 60, align: "start", base: "middle" },
    { s: "NOV 26 · 5:39 PM", size: 34, x: 54, y: 60, align: "start", base: "middle", color: "#fff", bg: "#000" },
    { s: "№043", size: 76, x: 554, y: 66, align: "right", base: "middle" },
    { s: "№043", size: 76, x: 548, y: 60, align: "right", base: "middle", color: "#fff", stroke: 3 },
    { s: "✂", size: 30, x: 0, y: 60, align: "start", base: "middle", emoji: true },
    { s: "▸ 01A", size: 22, x: 288, y: 60, align: "center", base: "alphabetic" },
    { s: "Thanksgiving 2026", size: 30, x: 288, y: 60, align: "center", base: "middle" },
    { s: "A very long footer that will not fit on one strip line", size: 30, x: 288, y: 60, align: "center", base: "middle", max: 516 },
    { s: "A", size: 40, x: 12, y: 60, align: "start", base: "middle" },
    { s: "Brownell party · 2026", size: 30, x: 288, y: 60, align: "center", base: "middle" },
  ];
  const text = TEXT.map((t) => {
    const c = new OffscreenCanvas(576, 120), x = c.getContext("2d", { willReadFrequently: true });
    x.fillStyle = t.bg ?? "#fff"; x.fillRect(0, 0, 576, 120);
    x.font = `${t.size}px ${t.emoji ? EMOJI : DISPLAY}`; x.textAlign = t.align; x.textBaseline = t.base;
    x.fillStyle = t.color ?? "#000";
    if (t.max) x.fillText(t.s, t.x, t.y, t.max); else x.fillText(t.s, t.x, t.y);
    if (t.stroke) { x.lineWidth = t.stroke; x.strokeStyle = "#000"; x.strokeText(t.s, t.x, t.y); }
    return { ...t, width: x.measureText(t.s).width, rgba: b64(new Uint8Array(x.getImageData(0, 0, 576, 120).data.buffer.slice(0))) };
  });

  // The ticket stub's date strings, as the booth formats them.
  const d = date.toLocaleDateString(undefined, { day: "numeric", month: "short" }).toUpperCase();
  const tm = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toUpperCase();
  return { cases: out, frames: frameData, stickers, text, silFix, stub: { label: `${d} · ${tm}`, year: String(date.getFullYear()) } };
}, cases);

const unb64 = (s) => Buffer.from(s, "base64");
const sha = (b) => createHash("sha256").update(b).digest("hex");
rmSync(STICKERS, { recursive: true, force: true }); mkdirSync(STICKERS, { recursive: true });
const hex = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join("_");
for (const s of result.stickers) writeFileSync(join(STICKERS, `${hex(s.emoji)}-${s.size}.z`), deflateRawSync(unb64(s.bgra), { level: 9 }));

rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
for (const [k, f] of Object.entries(result.frames)) writeFileSync(join(OUT, `frame-${k}.z`), deflateRawSync(unb64(f.rgba)));
const hashes = {};
const manifest = { stub: result.stub, frames: Object.fromEntries(Object.entries(result.frames).map(([k, f]) => [k, { w: f.w, h: f.h }])), cases: [] };
for (const c of result.cases) {
  const rgba = unb64(c.rgba);
  writeFileSync(join(OUT, `${c.name}.rgba.z`), deflateRawSync(rgba));
  c.bits.forEach((b, i) => writeFileSync(join(OUT, `${c.name}.bits${i}.z`), deflateRawSync(unb64(b))));
  hashes[c.name] = { rgba: sha(rgba), bits: c.bits.map((b) => sha(unb64(b))) };
  c.tiles.forEach((t, i) => { writeFileSync(join(OUT, `${c.name}.tile${i}.z`), deflateRawSync(unb64(t.rgba))); writeFileSync(join(OUT, `${c.name}.tone${i}.z`), deflateRawSync(unb64(t.tone))); if (t.put) { writeFileSync(join(OUT, `${c.name}.put${i}.z`), deflateRawSync(unb64(t.put))); writeFileSync(join(OUT, `${c.name}.rot${i}.z`), deflateRawSync(unb64(t.rot))); } });
  const { rgba: _r, bits: _b, tiles, ...meta } = c;
  meta.tileSizes = tiles.map((t) => [t.w, t.h, t.x]);
  manifest.cases.push(meta);
}
for (const k of ["stack", "halo", "shadow"]) writeFileSync(join(OUT, `sil-${k}.z`), deflateRawSync(unb64(result.silFix[k])));
manifest.silS = result.silFix.S;
manifest.text = result.text.map(({ rgba, ...t }, i) => { writeFileSync(join(OUT, `text${i}.z`), deflateRawSync(unb64(rgba))); return t; });
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
writeFileSync(join(CORE, "Tests/BoothCoreTests/Fixtures/strips.sha256.json"), JSON.stringify({ stub: result.stub, hashes }, null, 1) + "\n");
console.log(`${result.cases.length} strips, ${result.stickers.length} stickers, stub "${result.stub.label}" ${result.stub.year}`);
await browser.close(); server.close();
