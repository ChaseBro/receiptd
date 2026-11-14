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

/**
 * Photo tone map for thermal paper: 1% auto-levels, gentle S-curve, and a
 * midtone lift (thermal dots spread, so unlifted mids print muddy).
 */
export function toneMap(gray) {
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
