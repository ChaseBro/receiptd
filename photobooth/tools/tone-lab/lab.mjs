// Tone lab: node tools/tone-lab/lab.mjs [srcDir ...]
// Compares photo tone maps through plain Atkinson (1-bit) with a ~1.5px
// viewing blur, prints metrics and writes contact sheets to tools/tone-lab/out/:
//   original | current (legacy toneMap) | proposed (public/raster.js toneMap)
// Sources: out/src/*.png, /Users/chase/src/photo-receipts/img PNGs (if
// present) and a synthesized backlit selfie. Face boxes are hand-marked
// (normalised source coords) and fed through frames.js coverCrop/facesToTile,
// the same mapping photoTile uses.
import { readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePNG, encodeGrayPNG } from "./png.mjs";
import { legacyToneMap, proposedToneMap, PR_PORTRAIT, photoReceiptsTone, gaussian } from "./tone.mjs";
import { coverCrop, facesToTile } from "../../public/frames.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const SRCS = process.argv.length > 2 ? process.argv.slice(2) : [join(OUT, "src"), "/Users/chase/src/photo-receipts/img"];
const TW = 528, TH = 396; // ≈ a landscape slot on the strip
mkdirSync(OUT, { recursive: true });

// Hand-marked faces, normalised [x, y, w, h] in source coords.
const FACES = {
  hat: [[0.33, 0.31, 0.24, 0.44]],
  mountain: [[0.45, 0.22, 0.19, 0.40]],
  street: [[0.33, 0.21, 0.42, 0.33]],
  sitting: [[0.40, 0.22, 0.25, 0.38]],
  "synthetic-backlit": [[0.24, 0.30, 0.17, 0.30], [0.58, 0.26, 0.17, 0.30]],
};

// ------------------------------------------------------------ dither
/** Plain Atkinson (= ditherThermal with gain 0). */
export function atkinson(gray, w, h) {
  const want = new Float32Array(w * h);
  for (let i = 0; i < want.length; i++) want[i] = 1 - gray[i] / 255;
  const bits = new Uint8Array(w * h);
  const add = (x, y, e) => { if (x >= 0 && x < w && y < h) want[y * w + x] += e; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, fired = want[i] > 0.5;
    bits[i] = fired ? 1 : 0;
    const e = (want[i] - (fired ? 1 : 0)) / 8;
    add(x + 1, y, e); add(x + 2, y, e); add(x - 1, y + 1, e); add(x, y + 1, e); add(x + 1, y + 1, e); add(x, y + 2, e);
  }
  return bits;
}
const bitsToGray = (bits) => Float32Array.from(bits, (b) => (b ? 0 : 255));

// ------------------------------------------------------------ sources
function cropResize(src, sw, sh, w, h) {
  const { sx: x0, sy: y0, sw: cw, sh: chh } = coverCrop(sw, sh, w, h);
  const kx = cw / w, ky = chh / h, out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { // area average
    let a = 0, n = 0;
    for (let yy = Math.floor(y0 + y * ky); yy < Math.min(sh, Math.ceil(y0 + (y + 1) * ky)); yy++)
      for (let xx = Math.floor(x0 + x * kx); xx < Math.min(sw, Math.ceil(x0 + (x + 1) * kx)); xx++) { a += src[yy * sw + xx]; n++; }
    out[y * w + x] = a / n;
  }
  return out;
}

/** Two kids in hoodies in front of a bright window (iPad-auto-exposed). */
function syntheticBacklit(w = 1056, h = 792) {
  const g = new Float32Array(w * h);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5);
  const inEll = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x / w, v = y / h;
    // window: 228..250 with mullions and faint blinds; wall right of it ~200
    let bg = u < 0.8 ? 238 + 8 * Math.sin(v * 90) * 0.5 + (Math.abs(u - 0.4) < 0.01 ? -30 : 0) : 196 - 20 * v;
    if (v > 0.85) bg = 70 + 10 * Math.sin(u * 40); // sofa back
    let px = bg;
    for (const [cx, cy] of [[0.325, 0.45], [0.665, 0.41]]) {
      // hoodie body with folds
      if (inEll(u, v, cx, cy + 0.55, 0.2, 0.42)) px = 18 + 7 * Math.sin((u - cx) * 70 + v * 20) + 4 * Math.sin(v * 55);
      // hair
      if (inEll(u, v, cx, cy, 0.105, 0.2)) px = 28 + 6 * Math.sin(u * 300);
      // face (dim skin, ~45) with eyes/mouth
      if (inEll(u, v, cx, cy + 0.03, 0.075, 0.14)) {
        px = 48 + 10 * (1 - (((u - cx) / 0.075) ** 2)) - 8 * v;
        if (inEll(u, v, cx - 0.03, cy, 0.012, 0.012) || inEll(u, v, cx + 0.03, cy, 0.012, 0.012)) px = 22;
        if (inEll(u, v, cx, cy + 0.09, 0.03, 0.012)) px = 28;
      }
    }
    g[y * w + x] = Math.max(0, Math.min(255, px + rnd() * 6));
  }
  return { w, h, gray: g };
}

function loadSources() {
  const out = [];
  for (const dir of SRCS) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => !f.startsWith(".") && !f.includes("_processed"))) {
      try {
        const img = decodePNG(join(dir, f));
        const name = basename(f, ".png");
        out.push({ name: dir.includes("photo-receipts") ? `pr-${name.slice(0, 6)}` : name, img });
      } catch { /* JPEG etc. — skipped */ }
    }
  }
  out.push({ name: "synthetic-backlit", img: syntheticBacklit() });
  return out;
}

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
function medianIn(v, mask) {
  const a = []; for (let i = 0; i < v.length; i++) if (mask[i]) a.push(v[i]);
  a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN;
}
/**
 * blown  % of source pixels that are NOT white (<235, local) but print as bare paper
 * solid  % of the source's darkest 20% that HAS texture (local σ>3) printing as solid black
 * detSh  correlation of 1.5–5px detail, print vs source, in those textured shadows
 * face   median printed (viewed) lightness inside the face boxes' inner 60%
 */
function metrics(orig, bits, w, h, faceMask) {
  const view = gaussian(bitsToGray(bits), w, h, 1.5), ov = gaussian(orig, w, h, 1.5);
  const o5 = gaussian(orig, w, h, 5), v5 = gaussian(bitsToGray(bits), w, h, 5);
  const dO = ov.map((v, i) => v - o5[i]), dV = view.map((v, i) => v - v5[i]);
  const sorted = Float32Array.from(o5).sort(), pLo = sorted[(sorted.length * 0.2) | 0];
  // textured shadows: darkest 20% where the source has real local variation
  const sq = gaussian(ov.map((v) => v * v), w, h, 3), m3 = gaussian(ov, w, h, 3);
  const sh = o5.map((v, i) => (v <= pLo && sq[i] - m3[i] ** 2 > 9 ? 1 : 0));
  let blown = 0, nonWhite = 0, solid = 0, nSh = 0;
  for (let i = 0; i < view.length; i++) {
    if (ov[i] < 235) { nonWhite++; if (view[i] > 250) blown++; }
    if (sh[i]) { nSh++; if (view[i] < 5) solid++; }
  }
  return {
    blown: (100 * blown) / Math.max(1, nonWhite), solid: (100 * solid) / Math.max(1, nSh),
    detSh: corr(dV, dO, sh), face: faceMask ? medianIn(view, faceMask) : NaN,
  };
}

// ------------------------------------------------------------ run
// TONE='{"black":6}' overrides DEFAULT_TONE knobs for the proposed columns.
const TONE = JSON.parse(process.env.TONE || "{}");
const CANDS = {
  current: (g) => legacyToneMap(g),
  "pr-portrait": (g) => photoReceiptsTone(g, PR_PORTRAIT),
  "proposed-noface": (g, w, h) => proposedToneMap(g, { ...TONE, width: w, height: h }),
  proposed: (g, w, h, faces) => proposedToneMap(g, { ...TONE, width: w, height: h, faces }),
};
const rows = [];
for (const { name, img } of loadSources()) {
  if (ONLY && !ONLY.includes(name)) continue;
  const orig = cropResize(img.gray, img.w, img.h, TW, TH);
  const crop = coverCrop(img.w, img.h, TW, TH);
  const srcFaces = (FACES[name] || []).map(([x, y, fw, fh]) => ({ x: x * img.w, y: y * img.h, w: fw * img.w, h: fh * img.h }));
  const faces = facesToTile(srcFaces, crop, TW, TH);
  let faceMask = null;
  if (faces.length) {
    faceMask = new Uint8Array(TW * TH);
    for (const f of faces) for (let y = Math.round(f.y + 0.2 * f.h); y < f.y + 0.8 * f.h; y++)
      for (let x = Math.round(f.x + 0.2 * f.w); x < f.x + 0.8 * f.w; x++) faceMask[y * TW + x] = 1;
  }
  const out = {}, m = {};
  for (const [k, fn] of Object.entries(CANDS)) {
    const target = fn(orig, TW, TH, faces);
    if (target.some((v) => !Number.isFinite(v))) throw new Error(`${k} NaN on ${name}`);
    out[k] = atkinson(target, TW, TH);
    m[k] = metrics(orig, out[k], TW, TH, faceMask);
  }
  rows.push({ name, orig, out, m, faces, origFace: faceMask ? medianIn(orig, faceMask) : NaN });
}

const f1 = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "–");
console.log("\nper image: blown% / solid% / detSh / face median (source face median in [])\n");
for (const r of rows) {
  console.log(r.name.padEnd(18) + (Number.isFinite(r.origFace) ? `[${r.origFace.toFixed(0)}]` : "").padEnd(6) +
    Object.entries(r.m).map(([k, m]) => `${k}: ${f1(m.blown)}/${f1(m.solid)}/${f1(m.detSh, 2)}/${f1(m.face, 0)}`).join("  "));
}
console.log("\nmean".padEnd(19) + "blown%  solid%  detSh   face(med of medians)");
for (const k of Object.keys(CANDS)) {
  const ms = rows.map((r) => r.m[k]);
  const mean = (key) => { const v = ms.map((m) => m[key]).filter(Number.isFinite); return v.reduce((a, b) => a + b, 0) / v.length; };
  const fm = ms.map((m) => m.face).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(k.padEnd(18) + f1(mean("blown")).padStart(7) + f1(mean("solid")).padStart(8) + f1(mean("detSh"), 3).padStart(8) + `   ${fm.map((v) => v.toFixed(0)).join(",")}`);
}

// contact sheets: original | current | proposed (1-bit), face boxes outlined on the original
const cols = ["orig", "current", "proposed"], G = 8;
const sw = cols.length * TW + (cols.length - 1) * G;
const all = new Float32Array(sw * rows.length * (TH + G)).fill(255);
rows.forEach((r, ri) => {
  const sheet = new Float32Array(sw * TH).fill(255);
  const o = Float32Array.from(r.orig);
  for (const f of r.faces) for (let y = Math.round(f.y); y < f.y + f.h; y++) for (let x = Math.round(f.x); x < f.x + f.w; x++) {
    if (y === Math.round(f.y) || x === Math.round(f.x) || y + 1 >= f.y + f.h || x + 1 >= f.x + f.w) o[y * TW + x] = 255;
  }
  cols.forEach((c, ci) => {
    const src = c === "orig" ? o : bitsToGray(r.out[c]);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      sheet[y * sw + ci * (TW + G) + x] = src[y * TW + x];
      all[(ri * (TH + G) + y) * sw + ci * (TW + G) + x] = src[y * TW + x];
    }
  });
  encodeGrayPNG(join(OUT, `sheet-${r.name}.png`), sheet, sw, TH);
});
encodeGrayPNG(join(OUT, "sheet-all.png"), all, sw, rows.length * (TH + G));
console.log(`\ncolumns: ${cols.join(" | ")}  →  ${OUT}/sheet-*.png`);

// timing: 3 tiles, as on the strip
const three = rows.slice(0, 3);
for (const [k, fn] of [["current", (r) => legacyToneMap(r.orig)], ["proposed", (r) => proposedToneMap(r.orig, { width: TW, height: TH, faces: r.faces })]]) {
  for (let i = 0; i < 3; i++) three.forEach(fn); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) three.forEach(fn);
  console.log(`${k} toneMap: ${((performance.now() - t0) / 20).toFixed(1)} ms per 3 tiles (${TW}×${TH}, desktop node)`);
}
