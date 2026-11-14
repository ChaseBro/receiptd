// Raster pipeline for the booth: grayscale tone-mapping, thermal-aware
// Atkinson dithering, and 1-bit packing. Pure functions over typed arrays so
// the same code runs in the browser and under `node --test`.
//
// Gray convention: 0 = black, 255 = white (canvas luminance).
// Bit convention: 1 = black dot (fired heater), MSB = leftmost pixel.

export const PRINT_WIDTH = 576; // 80mm @ 203dpi

/** RGBA ImageData-ish → luminance Float32Array (0..255). */
export function luminance(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return out;
}

/** Tone-map knobs; any can be overridden through toneMap's `opts`. */
export const DEFAULT_TONE = Object.freeze({
  levels: 0.005,    // auto-levels clip per end (0.5%)
  minSpan: 96,      // never stretch flatter than this (keeps flat images calm)
  local: 0.35,      // CLAHE-lite blend (0 = off)
  clip: 1.6,        // CLAHE clip limit (× mean bin); higher amplifies noise
  tilesX: 6, tilesY: 4,
  mid: 0.5,         // no faces: centre-weighted median lands here (pre-toe)
  face: 0.64,       // faces: face median lands here (~163/255 printed)
  black: 12,        // toe floor: hoodie folds survive; higher speckles flat blacks
  shoulder: 0.86,   // highlight shoulder starts here…
  white: 0.965,     // …and the brightest non-clipped tones end here (faint dots)
  sharpen: 0.6,     // unsharp-mask amount (σ≈1 px) — thermal dots soften detail
  trc: 1,           // Atkinson tone-response precompensation strength (0..1)
});

// Inverse of plain-Atkinson tone response (measured on flat patches, see
// tools/tone-lab): input level that *prints* as the wanted lightness.
// Atkinson drops 1/4 of the error, so inputs above ~224 print as bare paper and
// below ~30 as solid black; this table pulls wanted tones back inside that band.
const TRC_WANT = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 248, 254];
const TRC_IN = [0, 39, 50, 65, 76, 88, 102, 115.5, 128, 140, 154, 168, 179, 190, 205, 217, 222, 224];
const TRC_LUT = (() => {
  const lut = new Float32Array(257);
  for (let v = 0, k = 0; v <= 254; v++) {
    while (TRC_WANT[k + 1] < v) k++;
    const a = TRC_WANT[k], b = TRC_WANT[k + 1];
    lut[v] = TRC_IN[k] + ((TRC_IN[k + 1] - TRC_IN[k]) * (v - a)) / (b - a);
  }
  lut[255] = lut[256] = 255; // true paper white stays paper
  return lut;
})();

/**
 * Contrast-limited adaptive histogram equalisation, light: tx×ty tiles,
 * 64 bins, bilinear blend of tile LUTs. In/out 0..255.
 */
function claheLite(src, w, h, tilesX, tilesY, clip, out) {
  const B = 64, luts = new Float32Array(tilesX * tilesY * B), hist = new Float32Array(B);
  const tw = w / tilesX, th = h / tilesY;
  for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
    hist.fill(0);
    const x0 = Math.round(tx * tw), x1 = Math.round((tx + 1) * tw);
    const y0 = Math.round(ty * th), y1 = Math.round((ty + 1) * th);
    for (let y = y0; y < y1; y++) for (let x = x0, r = y * w; x < x1; x++) hist[(src[r + x] * (B / 256)) | 0]++;
    const n = (x1 - x0) * (y1 - y0), limit = Math.max(1, (clip * n) / B);
    let excess = 0;
    for (let b = 0; b < B; b++) if (hist[b] > limit) { excess += hist[b] - limit; hist[b] = limit; }
    const add = excess / B, base = (ty * tilesX + tx) * B;
    // value at the bin's centre (half its own count), so a flat tile maps to itself-ish
    for (let b = 0, acc = 0; b < B; b++) { const c = hist[b] + add; luts[base + b] = ((acc + c / 2) / n) * 255; acc += c; }
  }
  // per-column tile indices + weights
  const cx0 = new Int32Array(w), cx1 = new Int32Array(w), cax = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.min(tilesX - 1, Math.max(0, (x + 0.5) / tw - 0.5));
    cx0[x] = Math.floor(fx); cx1[x] = Math.min(tilesX - 1, cx0[x] + 1); cax[x] = fx - cx0[x];
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(tilesY - 1, Math.max(0, (y + 0.5) / th - 0.5));
    const ty0 = Math.floor(fy), ty1 = Math.min(tilesY - 1, ty0 + 1), ay = fy - ty0;
    const r0 = ty0 * tilesX * B, r1 = ty1 * tilesX * B;
    for (let x = 0, i = y * w; x < w; x++, i++) {
      const v = Math.max(0, src[i] * (B / 256) - 0.5), b = v < B - 1 ? v | 0 : B - 2, fb = Math.min(1, v - b);
      const o00 = r0 + cx0[x] * B + b, o01 = r0 + cx1[x] * B + b, o10 = r1 + cx0[x] * B + b, o11 = r1 + cx1[x] * B + b;
      const l00 = luts[o00] + (luts[o00 + 1] - luts[o00]) * fb, l01 = luts[o01] + (luts[o01 + 1] - luts[o01]) * fb;
      const l10 = luts[o10] + (luts[o10 + 1] - luts[o10]) * fb, l11 = luts[o11] + (luts[o11 + 1] - luts[o11]) * fb;
      const ax = cax[x];
      out[i] = (l00 + (l01 - l00) * ax) * (1 - ay) + (l10 + (l11 - l10) * ax) * ay;
    }
  }
  return out;
}

/** In-place unsharp mask with a 5-tap binomial blur (σ≈1 px), clamped to floor..255. */
function unsharp(g, w, h, amount, floor = 0) {
  const tmp = new Float32Array(w * h), row = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const a = r + (x > 1 ? x - 2 : 0), b = r + (x > 0 ? x - 1 : 0), d = r + (x < w - 1 ? x + 1 : w - 1), e = r + (x < w - 2 ? x + 2 : w - 1);
      tmp[r + x] = (g[a] + 4 * g[b] + 6 * g[r + x] + 4 * g[d] + g[e]) * (1 / 16);
    }
  }
  // vertical pass reads tmp only, so g can be overwritten row by row
  for (let y = 0; y < h; y++) {
    const a = (y > 1 ? y - 2 : 0) * w, b = (y > 0 ? y - 1 : 0) * w, r = y * w, d = (y < h - 1 ? y + 1 : h - 1) * w, e = (y < h - 2 ? y + 2 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      row[x] = (tmp[a + x] + 4 * tmp[b + x] + 6 * tmp[r + x] + 4 * tmp[d + x] + tmp[e + x]) * (1 / 16);
    }
    for (let x = 0; x < w; x++) {
      const v = g[r + x] + amount * (g[r + x] - row[x]);
      g[r + x] = v < floor ? floor : v > 255 ? 255 : v;
    }
  }
}

/** Weighted median of 0..255 values (weights optional). */
function median(g, weight) {
  const hist = new Float64Array(256);
  let total = 0;
  for (let i = 0; i < g.length; i++) {
    const wt = weight ? weight[i] : 1;
    if (wt) { hist[g[i] < 0 ? 0 : g[i] > 255 ? 255 : g[i] | 0] += wt; total += wt; }
  }
  if (!total) return NaN;
  for (let v = 0, acc = 0; v < 256; v++) { acc += hist[v]; if (acc >= total / 2) return v + 0.5; }
  return 255;
}

/**
 * Photo tone map for thermal paper (0 = black, 255 = white).
 *
 *   1. auto-levels from the 0.5 / 99.5 percentiles (min span so flat stays flat)
 *   2. CLAHE-lite local contrast, blended in at `local`  (needs width/height)
 *   3. exposure: a rational curve t/(t + c(1−t)) that puts the face median
 *      (opts.faces) at `face` — that's what rescues backlit kids — else the
 *      centre-weighted median at `mid`. Unlike a gamma it keeps a finite
 *      slope at black, so darkening a bright face doesn't crush the hoodie,
 *      and brightening compresses highlights instead of clipping them.
 *   4. toe (black floor `black`, so hoodies keep folds) + soft highlight
 *      shoulder (bright walls keep a few dots; only clipped white is paper)
 *   5. unsharp mask (thermal dots soften edges)
 *   6. invert Atkinson's tone response so all of 2–5 survives dithering
 *
 * opts: { width, height, faces: [{x,y,w,h}] in tile pixels, ...DEFAULT_TONE }.
 * With no width/height (old 1-arg call) steps 2 and 5 are skipped and
 * metering is global.
 */
export function toneMap(gray, opts = {}) {
  const p = { ...DEFAULT_TONE, ...opts };
  const n = gray.length, w = opts.width | 0, h = opts.height | 0;
  const is2D = w > 0 && h > 0 && w * h === n;
  const out = new Float32Array(n);
  if (!n) return out;

  // 1. levels
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) { const v = gray[i]; hist[v > 0 ? (v < 255 ? v | 0 : 255) : 0]++; }
  const cut = n * p.levels;
  let lo = 0, hi = 255;
  for (let v = 0, acc = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
  for (let v = 255, acc = 0; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
  const flat = hi - lo < p.minSpan; // nothing to equalise or meter
  if (flat) {
    const c = (hi + lo) / 2;
    hi = Math.min(255, Math.max(hi, c + p.minSpan / 2)); lo = Math.max(0, Math.min(lo, hi - p.minSpan));
  }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < n; i++) { const v = (gray[i] - lo) * k; out[i] = v > 0 ? (v < 255 ? v : 255) : 0; }

  // 2. local contrast
  if (is2D && p.local > 0 && !flat) {
    const c = claheLite(out, w, h, p.tilesX, p.tilesY, p.clip, new Float32Array(n));
    for (let i = 0; i < n; i++) out[i] += (c[i] - out[i]) * p.local;
  }

  // 3. metering
  let weight = null, target = p.mid, faced = false;
  const faces = is2D && Array.isArray(opts.faces) ? opts.faces : [];
  if (faces.length) {
    // inner 60% of each box: skin, not hair or the window behind
    weight = new Uint8Array(n);
    let count = 0;
    for (const f of faces) {
      if (!f || !(f.w > 0 && f.h > 0)) continue;
      const x0 = Math.max(0, Math.round(f.x + f.w * 0.2)), x1 = Math.min(w, Math.round(f.x + f.w * 0.8));
      const y0 = Math.max(0, Math.round(f.y + f.h * 0.2)), y1 = Math.min(h, Math.round(f.y + f.h * 0.8));
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (!weight[y * w + x]) count++; weight[y * w + x] = 1; }
    }
    if (count >= 32) { target = p.face; faced = true; } else weight = null;
  }
  if (!weight && is2D) {
    weight = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x / w - 0.5) / 0.3, dy = (y / h - 0.45) / 0.3;
      weight[y * w + x] = dx * dx + dy * dy < 1 ? 3 : 1;
    }
  }
  const med = Math.min(0.99, Math.max(0.01, (median(out, weight) || 128) / 255));
  if (faced && med < target) {
    // Lift a dark face fully only when the scene around it is much brighter
    // (backlit). In a dark scene, or for darker skin in a normal room, close
    // most of the gap to the surround rather than washing everything out.
    const bg = (median(out, weight.map((v) => 1 - v)) || 128) / 255;
    target = Math.min(target, med + Math.max(0.15, 0.7 * (bg - med)));
  }
  // Faces may be lifted a lot (backlit) but only darkened a little: a bright
  // face prints clean on thermal, a darkened one goes grey and wormy.
  const [cMin, cMax] = faced ? [0.12, 1.6] : [0.4, 2];
  const c = flat ? 1 : Math.min(cMax, Math.max(cMin, (med * (1 - target)) / (target * (1 - med))));

  // 4. exposure + toe/shoulder, as a 256-entry curve (fast, smooth enough)
  const curve = new Float32Array(257);
  const b = p.black / 255, s = p.shoulder, top = p.white;
  for (let v = 0; v <= 256; v++) {
    const t0 = Math.min(255, v) / 255;
    let u = t0 / (t0 + c * (1 - t0));
    if (u > s) {
      // quadratic shoulder: slope 1 at s, reaches `top` at u = 1
      const t = (u - s) / (1 - s), a = (top - s) / (1 - s);
      u = s + (1 - s) * (t + (a - 1) * t * t);
    }
    curve[v] = (b + (1 - b) * u) * 255;
  }
  for (let i = 0; i < n; i++) {
    const v = out[i], j = v | 0, f = v - j;
    // clipped white stays bare paper; everything below gets the shoulder
    out[i] = v >= 254.5 ? 255 : curve[j] + (curve[j + 1] - curve[j]) * f;
  }

  // 5. sharpen
  if (is2D && p.sharpen > 0) unsharp(out, w, h, p.sharpen, p.black); // don't undo the toe

  // 6. printer precompensation (blend toward identity by 1 - trc)
  if (p.trc > 0) {
    for (let i = 0; i < n; i++) {
      const v = out[i], j = v | 0, f = v - j;
      const l = TRC_LUT[j] + (TRC_LUT[j + 1] - TRC_LUT[j]) * f;
      out[i] = v + (l - v) * p.trc;
    }
  }
  return out;
}

/**
 * Thermal print-head model (after Saquib/Vetterling US6819347B2's
 * per-element heat state, folded into Pappas–Neuhoff model-based error
 * diffusion). Each heater element carries two heat values in 0..1, each an
 * exponential moving average of how often it fired:
 *   fast — thin-film element, memory of a few lines (`fastDecay`)
 *   slow — substrate/heat-sink under it, memory of ~100 lines (`slowDecay`)
 * Both share heat with lateral neighbours (`spread`). A dot fired on a hot
 * element prints larger, i.e. darker than nominal by `gain * heat` (capped at
 * `maxGain`); a warm element also greys unfired paper a little (`bleed`).
 */
export const DEFAULT_THERMAL = Object.freeze({
  gain: 0.3,        // extra darkness of a dot fired on a fully hot element
  fastDecay: 0.7,   // per-line retention, element (~3 lines)
  slowDecay: 0.985, // per-line retention, substrate (~65 lines ≈ 8mm)
  slowWeight: 0.6,  // share of the slow component in effective heat
  spread: 0.15,     // fraction of heat shared with each lateral neighbour
  maxGain: 0.8,     // cap on extra darkness for a single dot
  bleed: 0.35,      // unfired pixel on a warm element greys by gain*heat*bleed
});

/**
 * Model-based Atkinson error diffusion: the diffused error is
 * (wanted darkness − darkness the printer will actually produce), where the
 * produced darkness comes from the thermal model. Hot regions end up with
 * fewer dots — including occasional skipped dots inside solid blacks — which
 * cancels the post-black "ghost".
 *
 * Returns Uint8Array of 0/1 per pixel (1 = black). gain = 0 → plain Atkinson.
 */
export function ditherThermal(gray, w, h, opts = {}) {
  const p = { ...DEFAULT_THERMAL, ...opts };
  const want = new Float32Array(w * h);
  for (let i = 0; i < want.length; i++) want[i] = 1 - gray[i] / 255;
  // Dot gain only shows where a dot can spill into paper that should stay
  // light; inside solid blacks it's invisible. So the penalty fades out as
  // the *target* tone approaches black (heat still accumulates there).
  const visible = new Float32Array(w * h);
  for (let i = 0; i < visible.length; i++) visible[i] = Math.min(1, 2 * (1 - want[i]));
  const bits = new Uint8Array(w * h);
  let fast = new Float32Array(w), slow = new Float32Array(w);
  const tmp = new Float32Array(w);

  const add = (x, y, e) => {
    if (x >= 0 && x < w && y < h) want[y * w + x] += e;
  };
  // Lateral spread + decay + this line's firing, in place.
  const advance = (heat, decay, row) => {
    for (let x = 0; x < w; x++) {
      const l = heat[x > 0 ? x - 1 : x], r = heat[x < w - 1 ? x + 1 : x];
      tmp[x] = (heat[x] * (1 - 2 * p.spread) + (l + r) * p.spread) * decay + (1 - decay) * bits[row + x];
    }
    heat.set(tmp);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const heat = (1 - p.slowWeight) * fast[x] + p.slowWeight * slow[x];
      const extra = Math.min(p.maxGain, p.gain * heat) * visible[i];
      const ifFired = 1 + extra, ifNot = extra * p.bleed;
      const fired = want[i] > (ifFired + ifNot) / 2;
      bits[i] = fired ? 1 : 0;
      const e = (want[i] - (fired ? ifFired : ifNot)) / 8;
      add(x + 1, y, e); add(x + 2, y, e);
      add(x - 1, y + 1, e); add(x, y + 1, e); add(x + 1, y + 1, e);
      add(x, y + 2, e);
    }
    if (p.gain > 0) {
      advance(fast, p.fastDecay, y * w);
      advance(slow, p.slowDecay, y * w);
    }
  }
  return bits;
}

/**
 * Solid-black relief: the post-black haze on *white* paper (no dots fired)
 * comes from heat the head has stored while burning a long run of dots in the
 * same elements — a photo's dark bottom + its offset block, the big ticket
 * numerals, the date pill. No amount of thinning in greys can remove it; the
 * only lever is to burn less at the source. So, column by column, track each
 * element's recent duty (EMA of its own + neighbours' dots) and, where it has
 * been firing solidly, skip a few dots on an evenly spread mask: density is
 * capped at `keep` inside sustained solids and ramps down to `edgeKeep` over
 * the last `ramp` rows before the black turns into light paper (where the
 * stored heat would spill). Dot gain on a hot head fills the holes back in,
 * so the solid still prints black.
 *
 * Protected (never thinned): any dot whose left or right neighbour is blank
 * (stroke edges and 1–2px lines stay crisp), the last `tail` rows of a dark
 * run (crisp trailing edge), and anything in elements that haven't been
 * running hot (duty below `heatOn` — short features and greys).
 *
 * bits: 0/1 per pixel (1 = black). Returns a new array; strength 0 = copy.
 */
export const DEFAULT_RELIEF = Object.freeze({
  strength: 1,      // 0 = off; scales how many dots are skipped (1 = keep/edgeKeep as given)
  keep: 0.88,       // max density inside a sustained solid
  edgeKeep: 0.7,    // max density on the last dark row before light paper
  ramp: 16,         // rows over which density ramps keep → edgeKeep
  tail: 0,          // last rows of a dark run left solid
  heatDecay: 0.85,  // per-line retention of the duty EMA (~6 lines)
  heatOn: 0.6,      // duty where relief starts; full relief at duty 1
});

// Hole mask: interleaved gradient noise (Jimenez 2014) as a threshold field.
// Holes come out evenly spread in 2D with no grid texture, and down every
// column — i.e. every heater element — they recur every ~8 rows at 12%, so
// each element gets regular rests.
const frac = (v) => v - Math.floor(v);
const holeRank = (x, y) => frac(52.9829189 * frac(0.06711056 * x + 0.00583715 * y));

export function relieveSolids(bits, w, h, opts = {}) {
  const p = { ...DEFAULT_RELIEF, ...opts };
  const out = Uint8Array.from(bits);
  if (!(p.strength > 0)) return out;
  // light[x,y]: 3-wide × 3-tall neighbourhood mostly blank — real paper, not a
  // dither hole inside a dark area. toLight: rows from here down to it.
  const toLight = new Uint16Array(w * h);
  const BIG = 65535;
  for (let x = 0; x < w; x++) {
    let d = BIG;
    for (let y = h - 1; y >= 0; y--) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          n += bits[yy * w + xx];
        }
      }
      d = n < 5 ? 0 : Math.min(BIG, d + 1);
      toLight[y * w + x] = d;
    }
  }
  const heat = new Float32Array(w);
  const a = p.heatDecay;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const l = bits[row + (x > 0 ? x - 1 : x)], r = bits[row + (x < w - 1 ? x + 1 : x)];
      heat[x] = a * heat[x] + (1 - a) * (0.25 * l + 0.5 * bits[row + x] + 0.25 * r);
    }
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!bits[i] || !bits[row + (x > 0 ? x - 1 : x)] || !bits[row + (x < w - 1 ? x + 1 : x)]) continue;
      const s = Math.min(1, Math.max(0, (heat[x] - p.heatOn) / (1 - p.heatOn)));
      if (s <= 0) continue;
      // rows incl. this one until light paper (1 = last dark row); past the end of
      // the image is paper too
      const d = Math.min(toLight[i], h - y);
      if (d <= p.tail) continue;
      const t = p.ramp > 0 ? Math.min(1, (d - 1 - p.tail) / p.ramp) : 1;
      const k = p.edgeKeep + (p.keep - p.edgeKeep) * t;
      const keep = 1 - p.strength * s * (1 - k);
      if (holeRank(x, y) >= keep) out[i] = 0;
    }
  }
  return out;
}

/** 0/1 per pixel → packed rows (w/8 bytes each). */
export function packBits(bits, w, h) {
  const bpr = w / 8;
  const out = new Uint8Array(bpr * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bits[y * w + x]) out[y * bpr + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

export function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
