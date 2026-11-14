// Tone-mapping candidates for thermal photo tiles. All take Float32 luminance
// 0..255 (0 = black) and return a new Float32Array 0..255.

export { toneMap as proposedToneMap } from "../../public/raster.js";

/** The pre-2026-11 toneMap (1% levels + S-curve + pow 0.85), for comparison. */
export function legacyToneMap(gray) {
  const hist = new Uint32Array(256);
  for (const v of gray) hist[Math.max(0, Math.min(255, v | 0))]++;
  const clip = gray.length * 0.01;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > clip) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > clip) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    let t = Math.min(1, Math.max(0, (gray[i] - lo) / span));
    t = t * t * (3 - 2 * t) * 0.6 + t * 0.4;
    out[i] = Math.pow(t, 0.85) * 255;
  }
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function histogram(gray, weight) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[clamp255(gray[i]) | 0] += weight ? weight[i] : 1;
  return hist;
}
export function percentile(hist, p) {
  let total = 0;
  for (const c of hist) total += c;
  const target = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v; }
  return 255;
}

// ---------------------------------------------------------------- blurs
/** Separable Gaussian, edge-clamped. */
export function gaussian(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    out[y * w + x] = a;
  }
  return out;
}

// ---------------------------------------------------------------- photo-receipts port
// lib/utils/histogramAnalysis.ts + autoAdjust.ts (post-5215aaf thresholds) and
// photoProcessor.ts applyBrightness → applyContrast → applyGamma → normalize.
function stats(gray) {
  const hist = histogram(gray);
  let sum = 0, n = gray.length;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  const mean = sum / n;
  let varr = 0;
  for (let v = 0; v < 256; v++) varr += (v - mean) ** 2 * hist[v];
  const p5 = percentile(hist, 0.05), p95 = percentile(hist, 0.95);
  return { mean, stdDev: Math.sqrt(varr / n), p5, p95, dynamicRange: p95 - p5 };
}
const isUnder = (s) => s.mean < 120 || s.p95 < 200;
const isOver = (s) => s.mean > 180 || s.p5 > 100;
const isLow = (s) => s.dynamicRange < 120 || s.stdDev < 40;
const isHigh = (s) => s.dynamicRange > 200 && s.stdDev > 70;
function recGamma(s) {
  if (s.p5 < 80) return Math.min(2.0, 1.4 + (Math.max(0, 80 - s.p5) / 80) * 0.6);
  if (isUnder(s)) return 1.0 + Math.max(0, 120 - s.mean) / 120;
  if (isOver(s) && s.mean > 200) return Math.max(0.8, 1.0 - (Math.max(0, s.mean - 200) / 55) * 0.2);
  return 1.0;
}
function recBrightness(s) {
  if (s.p5 < 80) return Math.min(100, Math.round(100 - s.p5 + (s.p5 < 50 ? 30 : 10)));
  if (s.mean > 100 && s.mean <= 140) return Math.round((140 - s.mean) * 0.5);
  if (s.mean > 140) return s.p95 < 200 ? Math.round((200 - s.p95) * 0.2) : 0;
  return Math.round(Math.max(-100, Math.min(100, (140 - s.mean) * 0.8)));
}
const recContrast = (s) => Math.round(Math.max(-100, Math.min(100, (200 - s.dynamicRange) * 0.3)));
function recNorm(s) {
  if (s.p5 < 80) return [0.5, 99];
  if (isUnder(s)) return [1, 98];
  if (isLow(s)) return [2, 97];
  if (isHigh(s)) return [8, 92];
  return [3, 97];
}
export function photoReceiptsParams(gray) {
  const s = stats(gray);
  let scene = "normal";
  if (s.mean < 120 || (s.mean < 140 && s.p95 < 200)) scene = "dark";
  else if (s.dynamicRange > 200 && s.p5 < 50 && s.p95 > 200) scene = "backlit";
  else if (isLow(s) && (s.mean < 80 || s.mean > 180)) scene = "document";
  else if (s.mean >= 100 && s.mean <= 160 && s.stdDev >= 40 && s.stdDev <= 70) scene = "portrait";
  else if (s.dynamicRange > 180 && s.stdDev > 60) scene = "landscape";
  const p = { brightness: 0, contrast: 0, gamma: 1, norm: [5, 95], scene };
  switch (scene) {
    case "dark": Object.assign(p, { brightness: Math.max(40, recBrightness(s)), gamma: Math.max(1.6, recGamma(s)), contrast: 25, norm: [0.5, 99] }); break;
    case "backlit": Object.assign(p, { gamma: 1.4, norm: [10, 90], contrast: 10 }); break;
    case "document": Object.assign(p, { contrast: 50, brightness: recBrightness(s) }); break;
    case "portrait": Object.assign(p, { gamma: 1.3, brightness: Math.max(15, recBrightness(s)), contrast: 10, norm: [2, 97] }); break;
    case "landscape": Object.assign(p, { contrast: recContrast(s), norm: [5, 95] }); break;
    default: Object.assign(p, { brightness: Math.max(recBrightness(s), s.mean < 140 ? 5 : 0), contrast: recContrast(s), gamma: recGamma(s), norm: recNorm(s) });
  }
  return p;
}
export const PR_PORTRAIT = { brightness: 15, contrast: 10, gamma: 1.3, norm: [2, 97], scene: "portrait" };
export function photoReceiptsTone(gray, fixed) {
  const p = fixed || photoReceiptsParams(gray);
  const q = (v) => Math.round(clamp255(v));
  let g = Float32Array.from(gray, (v) => q(v + (p.brightness / 100) * 255));
  const f = (p.contrast + 100) / 100;
  g = g.map((v) => q((v - 128) * f + 128));
  g = g.map((v) => q(Math.pow(v / 255, 1 / p.gamma) * 255));
  const hist = histogram(g);
  // percentile() is inclusive like getHistogramPercentile
  const lo = percentile(hist, p.norm[0] / 100), hi = percentile(hist, p.norm[1] / 100);
  if (hi > lo && !(lo === 0 && hi === 255)) g = g.map((v) => q(((v - lo) / (hi - lo)) * 255));
  return g;
}

// ---------------------------------------------------------------- building blocks
/** CLAHE: tx×ty tiles, clip limit as multiple of the mean bin, bilinear LUT blend. */
export function clahe(gray, w, h, { tilesX = 8, tilesY = 6, clip = 2.5 } = {}) {
  const BINS = 64; // 64 bins is plenty for 1-bit output and 4× cheaper to build
  const luts = new Float32Array(tilesX * tilesY * BINS);
  const tw = w / tilesX, th = h / tilesY;
  const hist = new Float32Array(BINS);
  for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
    hist.fill(0);
    const x0 = Math.round(tx * tw), x1 = Math.round((tx + 1) * tw);
    const y0 = Math.round(ty * th), y1 = Math.round((ty + 1) * th);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[Math.min(BINS - 1, (clamp255(gray[y * w + x]) * (BINS / 256)) | 0)]++;
    const n = (x1 - x0) * (y1 - y0), limit = Math.max(1, (clip * n) / BINS);
    let excess = 0;
    for (let b = 0; b < BINS; b++) if (hist[b] > limit) { excess += hist[b] - limit; hist[b] = limit; }
    const add = excess / BINS;
    let acc = 0;
    const base = (ty * tilesX + tx) * BINS;
    for (let b = 0; b < BINS; b++) { acc += hist[b] + add; luts[base + b] = (acc / n) * 255; }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(tilesY - 1, Math.max(0, (y + 0.5) / th - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(tilesY - 1, y0 + 1), ay = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(tilesX - 1, Math.max(0, (x + 0.5) / tw - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(tilesX - 1, x0 + 1), ax = fx - x0;
      const v = clamp255(gray[y * w + x]) * (BINS / 256);
      const b = Math.min(BINS - 2, v | 0), fb = Math.min(1, v - b);
      const L = (tx, ty) => { const o = (ty * tilesX + tx) * BINS + b; return luts[o] + (luts[o + 1] - luts[o]) * fb; };
      out[y * w + x] = (L(x0, y0) * (1 - ax) + L(x1, y0) * ax) * (1 - ay) + (L(x0, y1) * (1 - ax) + L(x1, y1) * ax) * ay;
    }
  }
  return out;
}

/** Unsharp mask with a 5-tap binomial (σ≈1) blur — cheap enough for a phone. */
export function unsharp(gray, w, h, amount = 0.6) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = x > 1 ? x - 2 : 0, xm1 = x > 0 ? x - 1 : 0, xp1 = x < w - 1 ? x + 1 : w - 1, xp2 = x < w - 2 ? x + 2 : w - 1;
      tmp[r + x] = (gray[r + xm2] + 4 * gray[r + xm1] + 6 * gray[r + x] + 4 * gray[r + xp1] + gray[r + xp2]) / 16;
    }
  }
  for (let y = 0; y < h; y++) {
    const ym2 = (y > 1 ? y - 2 : 0) * w, ym1 = (y > 0 ? y - 1 : 0) * w, yp1 = (y < h - 1 ? y + 1 : h - 1) * w, yp2 = (y < h - 2 ? y + 2 : h - 1) * w, r = y * w;
    for (let x = 0; x < w; x++) {
      const blur = (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[r + x] + 4 * tmp[yp1 + x] + tmp[yp2 + x]) / 16;
      out[r + x] = clamp255(gray[r + x] + amount * (gray[r + x] - blur));
    }
  }
  return out;
}

/**
 * Printer tone-response precompensation. Plain Atkinson (drops 2/8 of the
 * error) prints light greys lighter and dark greys darker than asked, and
 * thermal dot gain darkens the mids. `trc` is a 256-entry table of printed
 * lightness for each input value (measured by lab.mjs); we invert it.
 */
export function inverseLUT(trc) {
  const inv = new Float32Array(256);
  for (let want = 0; want < 256; want++) {
    let v = 0;
    while (v < 255 && trc[v + 1] <= want) v++;
    const a = trc[v], b = v < 255 ? trc[v + 1] : 255;
    inv[want] = v + (b > a ? Math.min(1, Math.max(0, (want - a) / (b - a))) : 0);
  }
  inv[0] = 0; inv[255] = 255;
  return inv;
}
const applyLUT = (g, lut) => g.map((v) => {
  const x = clamp255(v), i = Math.min(254, x | 0), f = x - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
});

// ---------------------------------------------------------------- candidates
/**
 * Proposed "face" pipeline:
 *  1. levels from 0.5/99.5 percentiles (min span so flat images don't get noisy)
 *  2. centre-weighted exposure: gamma so the centre-weighted median lands on `mid`
 *  3. toe/shoulder: linear ends (no S-curve), black lifted to `black`, white
 *     shoulder so near-white skin keeps a few dots
 *  4. CLAHE blended in at `local`
 *  5. unsharp mask `sharpen`
 *  6. printer TRC precompensation (optional LUT)
 */
export function faceTone(gray, w, h, o = {}) {
  const p = { mid: 0.5, gammaMin: 0.65, gammaMax: 1.6, black: 14, shoulder: 0.88, white: 250, local: 0.45, clip: 2.0, tilesX: 6, tilesY: 4, sharpen: 0.7, lut: null, ...o };
  const n = gray.length;
  // centre-weighted metering: ellipse weight 1 + 2·(inside centre 60%)
  const wt = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x / w - 0.5) / 0.3, dy = (y / h - 0.45) / 0.3;
    wt[y * w + x] = dx * dx + dy * dy < 1 ? 3 : 1;
  }
  const hist = histogram(gray);
  let lo = percentile(hist, 0.005), hi = percentile(hist, 0.995);
  if (hi - lo < 96) { const c = (hi + lo) / 2; lo = Math.max(0, c - 48); hi = Math.min(255, c + 48); }
  const span = Math.max(1, hi - lo);
  const t = Float32Array.from(gray, (v) => clamp01((v - lo) / span));
  // exposure from centre-weighted median
  const ch = new Float64Array(256);
  for (let i = 0; i < n; i++) ch[(t[i] * 255) | 0] += wt[i];
  const med = Math.max(1, percentile(ch, 0.5)) / 255;
  const gamma = Math.min(p.gammaMax, Math.max(p.gammaMin, Math.log(p.mid) / Math.log(Math.min(0.99, med))));
  let g = new Float32Array(n);
  const b = p.black / 255, wh = p.white / 255, s = p.shoulder;
  const a = Math.min(2, (1 - s) / Math.max(1e-3, wh - s)); // slope-continuous at s
  for (let i = 0; i < n; i++) {
    let u = Math.pow(t[i], gamma);
    // soft shoulder: above s, compress toward `white` (keeps highlight dots)
    if (u > s) { const k = (u - s) / (1 - s); u = s + (wh - s) * (a * k + (1 - a) * k * k); }
    // toe: lift black so dark fabric keeps a little texture
    u = b + (1 - b) * u;
    g[i] = u * 255;
  }
  if (p.local > 0) {
    const c = clahe(g, w, h, { tilesX: p.tilesX, tilesY: p.tilesY, clip: p.clip });
    for (let i = 0; i < n; i++) g[i] = g[i] * (1 - p.local) + c[i] * p.local;
  }
  if (p.sharpen > 0) g = unsharp(g, w, h, p.sharpen);
  if (p.lut) g = applyLUT(g, p.lut);
  return g;
}

export { applyLUT };
