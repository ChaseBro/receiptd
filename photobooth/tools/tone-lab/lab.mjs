// Tone lab: node tools/tone-lab/lab.mjs [srcDir]
// Evaluates photo tone candidates through plain Atkinson + ~1.5px viewing blur
// and writes contact sheets to tools/tone-lab/out/.
import { readdirSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG, encodeGrayPNG } from "./png.mjs";
import { currentToneMap, photoReceiptsTone, photoReceiptsParams, faceTone, unsharp, gaussian, inverseLUT } from "./tone.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const SRC = process.argv[2] || join(OUT, "src");
const TW = 528, TH = 396;
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------ dithers
/** Plain Atkinson (= ditherThermal with gain 0). serpentine flips odd rows. */
export function atkinson(gray, w, h, { serpentine = false } = {}) {
  const want = new Float32Array(w * h);
  for (let i = 0; i < want.length; i++) want[i] = 1 - gray[i] / 255;
  const bits = new Uint8Array(w * h);
  const add = (x, y, e) => { if (x >= 0 && x < w && y < h) want[y * w + x] += e; };
  for (let y = 0; y < h; y++) {
    const rev = serpentine && y & 1, d = rev ? -1 : 1;
    for (let k = 0; k < w; k++) {
      const x = rev ? w - 1 - k : k, i = y * w + x;
      const fired = want[i] > 0.5;
      bits[i] = fired ? 1 : 0;
      const e = (want[i] - (fired ? 1 : 0)) / 8;
      add(x + d, y, e); add(x + 2 * d, y, e);
      add(x - d, y + 1, e); add(x, y + 1, e); add(x + d, y + 1, e);
      add(x, y + 2, e);
    }
  }
  return bits;
}
const bitsToGray = (bits) => Float32Array.from(bits, (b) => (b ? 0 : 255));

// ------------------------------------------------------------ source prep
function cropResize(src, sw, sh, w, h) {
  const da = w / h;
  let cw = sw, chh = sh;
  if (sw / sh > da) cw = sh * da; else chh = sw / da;
  const x0 = (sw - cw) / 2, y0 = (sh - chh) / 2, sx = cw / w, sy = chh / h;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // area average
    let a = 0, n = 0;
    for (let yy = Math.floor(y0 + y * sy); yy < Math.ceil(y0 + (y + 1) * sy); yy++)
      for (let xx = Math.floor(x0 + x * sx); xx < Math.ceil(x0 + (x + 1) * sx); xx++) { a += src[yy * sw + xx]; n++; }
    out[y * w + x] = a / n;
  }
  return out;
}

// ------------------------------------------------------------ printer TRC
/** Printed lightness (viewed, Atkinson) for each flat input level, with mild texture. */
function measureTRC() {
  const N = 96, trc = new Float32Array(256);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5);
  for (let v = 0; v < 256; v++) {
    const patch = new Float32Array(N * N);
    for (let i = 0; i < patch.length; i++) patch[i] = Math.min(255, Math.max(0, v + rnd() * 6));
    const bits = atkinson(patch, N, N);
    let dark = 0, cnt = 0;
    for (let y = 16; y < N; y++) for (let x = 0; x < N; x++) { dark += bits[y * N + x]; cnt++; }
    trc[v] = 255 * (1 - dark / cnt);
  }
  for (let v = 1; v < 256; v++) trc[v] = Math.max(trc[v], trc[v - 1]); // monotone
  return trc;
}
const TRC = measureTRC();
const LUT = inverseLUT(TRC);

// ------------------------------------------------------------ candidates
const CANDS = {
  current: (g) => currentToneMap(g),
  photoReceipts: (g) => photoReceiptsTone(g),
  "current+usm": (g, w, h) => unsharp(currentToneMap(g), w, h, 0.7),
  "clahe-only": (g, w, h) => faceTone(g, w, h, { mid: 0.5, black: 0, shoulder: 1, white: 255, local: 0.6, sharpen: 0 }),
  "face-nolut": (g, w, h) => faceTone(g, w, h),
  face: (g, w, h) => faceTone(g, w, h, { lut: LUT }),
  "face-soft": (g, w, h) => faceTone(g, w, h, { lut: LUT, local: 0.3, sharpen: 0.5, black: 18, white: 244 }),
};

// ------------------------------------------------------------ metrics
function corr(a, b, mask) {
  let sa = 0, sb = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (mask[i]) { sa += a[i]; sb += b[i]; n++; }
  if (n < 50) return NaN;
  const ma = sa / n, mb = sb / n;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) if (mask[i]) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return ab / Math.sqrt(aa * bb + 1e-9);
}
function metrics(orig, target, bits, w, h) {
  const view = gaussian(bitsToGray(bits), w, h, 1.5);
  const tv = gaussian(target, w, h, 1.5);
  const ov = gaussian(orig, w, h, 1.5);
  const o5 = gaussian(orig, w, h, 5), v5 = gaussian(bitsToGray(bits), w, h, 5);
  const det = (a, b) => a.map((v, i) => v - b[i]); // band-pass 1.5..5 px
  const dO = det(ov, o5), dV = det(view, v5);
  // masks from the original's local tone
  const hist = new Float64Array(256);
  for (const v of o5) hist[Math.max(0, Math.min(255, v | 0))]++;
  const pct = (p) => { let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= p * o5.length) return v; } return 255; };
  const pLo = pct(0.2), pHi = pct(0.8); // per-image shadow/highlight bands
  const sh = o5.map((v) => (v <= pLo ? 1 : 0)), hi = o5.map((v, i) => (v >= pHi && ov[i] < 250 ? 1 : 0));
  const mid = o5.map((v) => (v > pLo && v < pHi ? 1 : 0));
  // smooth mid/light regions (skin-like): low original local variance
  const sq = gaussian(ov.map((v) => v * v), w, h, 3), m3 = gaussian(ov, w, h, 3);
  const smooth = ov.map((v, i) => (sq[i] - m3[i] ** 2 < 25 && o5[i] > pLo && o5[i] < 235 ? 1 : 0));
  let blank = 0, nHi = 0, solid = 0, nSh = 0, err = 0, errO = 0, grainS = 0, nS = 0, gm = 0;
  const diff = view.map((v, i) => v - tv[i]);
  for (let i = 0; i < view.length; i++) {
    if (hi[i]) { nHi++; if (view[i] > 250) blank++; }
    if (sh[i]) { nSh++; if (view[i] < 5) solid++; }
    err += Math.abs(view[i] - tv[i]); errO += Math.abs(view[i] - ov[i]);
    if (smooth[i]) { gm += diff[i]; nS++; }
  }
  gm /= Math.max(1, nS);
  for (let i = 0; i < view.length; i++) if (smooth[i]) grainS += (diff[i] - gm) ** 2;
  return {
    blankHi: (100 * blank) / Math.max(1, nHi),       // % of light (non-clipped) original printing as bare paper
    solidSh: (100 * solid) / Math.max(1, nSh),       // % of darkest-20% printing as solid black
    detSh: corr(dV, dO, sh), detMid: corr(dV, dO, mid), detHi: corr(dV, dO, hi),
    grain: Math.sqrt(grainS / Math.max(1, nS)),      // RMS viewed noise in smooth mids (worms)
    errT: err / view.length, errO: errO / view.length,
  };
}

// ------------------------------------------------------------ run
const files = readdirSync(SRC).filter((f) => !f.startsWith("."));
const rows = [], agg = {};
const SHEET = ["current", "photoReceipts", "face", "face-soft"];
for (const f of files) {
  let img;
  try { img = decodePNG(join(SRC, f)); } catch (e) { console.log(`skip ${f}: ${e.message}`); continue; }
  const orig = cropResize(img.gray, img.w, img.h, TW, TH);
  const name = basename(f, ".png");
  const out = {};
  for (const [k, fn] of Object.entries(CANDS)) {
    const target = fn(orig, TW, TH);
    for (const serp of [false, true]) {
      if (serp && !["current", "face"].includes(k)) continue;
      const key = serp ? `${k}+serp` : k;
      const bits = atkinson(target, TW, TH, { serpentine: serp });
      const m = metrics(orig, target, bits, TW, TH);
      (agg[key] ||= []).push(m);
      out[key] = bits;
    }
  }
  rows.push({ name, orig, out, scene: photoReceiptsParams(orig).scene });
}

// metrics table (mean over images)
const keys = ["blankHi", "solidSh", "detSh", "detMid", "detHi", "grain", "errT", "errO"];
console.log(`\nimages: ${rows.map((r) => `${r.name}(${r.scene})`).join(", ")}\n`);
console.log("candidate".padEnd(16) + keys.map((k) => k.padStart(8)).join(""));
for (const [k, ms] of Object.entries(agg)) {
  const mean = (key) => ms.reduce((a, m) => a + (isNaN(m[key]) ? 0 : m[key]), 0) / ms.filter((m) => !isNaN(m[key])).length;
  console.log(k.padEnd(16) + keys.map((key) => mean(key).toFixed(key.startsWith("det") ? 3 : 1).padStart(8)).join(""));
}
if (process.env.PER_IMAGE) for (const [k, ms] of Object.entries(agg)) console.log(k, ms.map((m) => `${m.blankHi.toFixed(0)}/${m.solidSh.toFixed(0)}`).join(" "));

// contact sheets: one per image, columns original | current | candidates (1-bit)
const cols = ["orig", ...SHEET], G = 8;
const sw = cols.length * TW + (cols.length - 1) * G;
const all = new Float32Array(sw * (rows.length * (TH + G))).fill(255);
rows.forEach((r, ri) => {
  const sheet = new Float32Array(sw * TH).fill(255);
  cols.forEach((c, ci) => {
    const src = c === "orig" ? r.orig : bitsToGray(r.out[c]);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      sheet[y * sw + ci * (TW + G) + x] = src[y * TW + x];
      all[(ri * (TH + G) + y) * sw + ci * (TW + G) + x] = src[y * TW + x];
    }
  });
  encodeGrayPNG(join(OUT, `sheet-${r.name}.png`), sheet, sw, TH);
});
encodeGrayPNG(join(OUT, "sheet-all.png"), all, sw, rows.length * (TH + G));
console.log(`\ncolumns: ${cols.join(" | ")}  →  ${OUT}/sheet-*.png`);

// TRC + timing
console.log("\nAtkinson TRC (input→printed):", [16, 32, 64, 128, 192, 224, 240, 248].map((v) => `${v}→${TRC[v].toFixed(0)}`).join(" "));
console.log("inverse LUT:", [16, 32, 64, 128, 192, 224, 240, 248].map((v) => `${v}→${LUT[v].toFixed(0)}`).join(" "));
const t0 = performance.now();
for (let i = 0; i < 20; i++) for (const r of rows.slice(0, 3)) faceTone(r.orig, TW, TH, { lut: LUT });
console.log(`faceTone: ${((performance.now() - t0) / 20).toFixed(1)} ms per 3 tiles (desktop node)`);
const t1 = performance.now();
for (let i = 0; i < 20; i++) for (const r of rows.slice(0, 3)) currentToneMap(r.orig);
console.log(`current toneMap: ${((performance.now() - t1) / 20).toFixed(1)} ms per 3 tiles`);
