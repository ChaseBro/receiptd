// QR size study: render real strips (public/frames.js in WebKit, the iPad's
// engine) with different QR module / quiet-zone sizes, dither them exactly as
// the booth does (raster.js, QR band = gain 0 / no relief), and write the
// 1-bit bitmaps plus a simulated thermal print (tools/thermal-sim dot gain).
// decode.swift then reads them back with Apple Vision.
//
//   node tools/qr-size/render.mjs          (from photobooth/; Playwright WebKit)
//   swiftc -O tools/qr-size/decode.swift -o tools/qr-size/out/decode && tools/qr-size/out/decode tools/qr-size/out
//
// Variants: `before` = frames.js at git HEAD; `mXqY` = the working frames.js
// with QR_MODULE = X, QR_QUIET = Y.
import { webkit } from "playwright";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { simulatePrint, sampleTruths } from "../thermal-sim/model.mjs";
import { encodePNG } from "../thermal-sim/png.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const PUBLIC = join(HERE, "../../public");
const OUT = join(HERE, "out");
const VARIANTS = (process.env.VARIANTS ?? "before,m5q4,m5q2,m5q1,m4q4,m4q2,m3q2").split(",");
const HEAD_FRAMES = execFileSync("git", ["show", "HEAD:photobooth/public/frames.js"], { cwd: HERE, encoding: "utf8" });

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".woff2": "font/woff2" };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__qr.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<!doctype html><html><head><style>@font-face { font-family:"Lilita"; src:url("/fonts/lilita-one.woff2") format("woff2"); font-display:block; }</style></head><body style="font-family:Lilita">x</body></html>`);
  }
  // /v/<variant>/<file>: frames.js patched per variant, everything else as is.
  let path = url.pathname, variant = null;
  const m = path.match(/^\/v\/([^/]+)(\/.*)$/);
  if (m) { variant = m[1]; path = m[2]; }
  const p = normalize(join(PUBLIC, path));
  if (!p.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    let b = readFileSync(p);
    if (variant && path === "/frames.js") {
      if (variant === "before") b = HEAD_FRAMES;
      else {
        const [, mod, quiet] = variant.match(/^m(\d+)q(\d+)$/);
        b = b.toString().replace(/const QR_MODULE = \d+;/, `const QR_MODULE = ${mod};`).replace(/const QR_QUIET = \d+;/, `const QR_QUIET = ${quiet};`);
      }
    }
    res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" }); res.end(b);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// Real link shapes: /a/<12-char token>/<base36 ms>-<8 hex>. Staging is the longest host.
const URLS = [
  "https://booth.receiptd.sh/a/k7m2p9qx4vtn/mih8x0k2-9f3a1c7e",
  "https://booth.receiptd.sh/a/abcdefghjkmn/mfx3k2a1-1a2b3c4d",
  "https://booth-staging.receiptd.sh/a/zzzzzzzzzzzz/mih8x0k2-0b1c2d3e",
];
const THEMES = ["film", "stars", "hearts", "party", "dino", "space", "turkey", "feast", "leaves", "starry", "harvest", "plain"];

const browser = await webkit.launch();
const page = await (await browser.newContext({ locale: "en-US", timezoneId: "America/New_York" })).newPage();
page.on("pageerror", (e) => console.error("pageerror", e.message));
await page.goto(base + "/__qr.html");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const truths = sampleTruths(6, 11);   // nominal + 5 random printers (dot gain, smear, heat)
const manifest = [];
for (const variant of VARIANTS) {
  const res = await page.evaluate(async ({ variant, URLS, THEMES }) => {
    await document.fonts.load("40px Lilita");
    const { compose } = await import(`/v/${variant}/frames.js`);
    const { luminance, ditherThermal, relieveSolids } = await import(`/v/${variant}/raster.js`);
    const { qrMatrix } = await import(`/v/${variant}/qr.js`);
    const frame = (kind, seed) => {
      const [w, h] = kind === "land" ? [1440, 1080] : [1080, 1350];
      const c = new OffscreenCanvas(w, h), x = c.getContext("2d");
      let s = seed; const r = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
      const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, "rgb(230,210,180)"); g.addColorStop(1, "rgb(40,60,90)");
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 14; i++) { x.fillStyle = `rgb(${(r() * 255) | 0},${(r() * 255) | 0},${(r() * 255) | 0})`; x.beginPath(); x.arc(r() * w, r() * h, 40 + r() * 220, 0, Math.PI * 2); x.fill(); }
      return c;
    };
    const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const out = [];
    THEMES.forEach((theme, ti) => URLS.forEach((qr, ui) => {
      const footer = (ti + ui) % 2 ? "Thanksgiving 2026" : "";
      const { canvas, layout } = compose([frame(ti % 2 ? "port" : "land", 99 + ti)], { theme, seed: 7 + ti, footer, ticket: 42 + ti, date: new Date("2026-11-26T17:39:00-05:00"), qr });
      const H = layout.H, gray = luminance(canvas.getContext("2d").getImageData(0, 0, 576, H).data, 576, H);
      const segs = [{ y0: 0, y1: layout.qrY, opts: { gain: 0.15, bleed: 0 } }, { y0: layout.qrY, y1: H, opts: { gain: 0, bleed: 0, relief: 0 } }];
      const bits = new Uint8Array(576 * H), state = { sink: 0 };
      segs.forEach((s) => {
        const d = ditherThermal(gray.subarray(s.y0 * 576, s.y1 * 576), 576, s.y1 - s.y0, s.opts);
        bits.set((s.opts.relief ?? 1) ? relieveSolids(d, 576, s.y1 - s.y0, { strength: 1, state }) : d, s.y0 * 576);
      });
      out.push({ theme, qr, footer, H, qrY: layout.qrY, qrSide: layout.qrSide, stubY: layout.stubY, version: (qrMatrix(qr).n - 17) / 4, bits: b64(bits) });
    }));
    return out;
  }, { variant, URLS, THEMES });
  for (const r of res) {
    const bits = Buffer.from(r.bits, "base64"), name = `${variant}-${r.theme}-${URLS.indexOf(r.qr)}`;
    const ideal = new Float32Array(576 * r.H);
    for (let i = 0; i < bits.length; i++) ideal[i] = bits[i] ? 0 : 255;
    encodePNG(join(OUT, `${name}.bits.png`), ideal, 576, r.H);
    // Simulated print on one of the sampled printers (rotating through them).
    const T = truths[(THEMES.indexOf(r.theme) + URLS.indexOf(r.qr)) % truths.length];
    const P = simulatePrint(Uint8Array.from(bits), 576, r.H, T);
    const paper = new Float32Array(P.length);
    for (let i = 0; i < P.length; i++) paper[i] = 255 * (1 - P[i]);
    encodePNG(join(OUT, `${name}.print.png`), paper, 576, r.H);
    manifest.push({ name, variant, theme: r.theme, url: r.qr, footer: r.footer, H: r.H, qrY: r.qrY, qrSide: r.qrSide, stubY: r.stubY, version: r.version });
  }
  const r0 = res[0];
  console.log(`${variant}: QR side ${r0.qrSide}px = ${(r0.qrSide * 25.4 / 203).toFixed(1)} mm (v${r0.version}), tail below stub ${r0.H - r0.stubY}px`);
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 1));
await browser.close(); server.close();
console.log(`wrote ${manifest.length * 2} PNGs → ${OUT}`);
