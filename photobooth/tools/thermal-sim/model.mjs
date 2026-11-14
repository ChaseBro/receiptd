// Compensator (generalised ditherThermal) + independent forward print model.
// Darkness convention inside this file: 0 = paper white, 1 = full black.

const KERNELS = {
  // [dx, dy, weight]; Atkinson deliberately drops 2/8 of the error.
  atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
  fs: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
  "sierra-lite": [[1, 0, 2 / 4], [-1, 1, 1 / 4], [0, 1, 1 / 4]],
};

export const RASTER_DEFAULTS = Object.freeze({
  gain: 0.3, fastDecay: 0.7, slowDecay: 0.985, slowWeight: 0.6, spread: 0.15, maxGain: 0.8, bleed: 0.35,
});

/** Separable box blur of a Float32Array (radius r, edge-clamped). */
export function boxBlur(src, w, h, r) {
  if (r <= 0) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[o + Math.min(w - 1, Math.max(0, x + k))];
      tmp[o + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
    out[y * w + x] = s / n;
  }
  return out;
}

export function gaussBlur(src, w, h, sigma) {
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += k[i + r] * src[o + Math.min(w - 1, Math.max(0, x + i))];
      tmp[o + x] = s;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
    out[y * w + x] = s;
  }
  return out;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Generalised model-based error diffusion. With default extras
 * (kernel atkinson, serpentine false, ref "abs", tailRows 0) it is bit-identical
 * to public/raster.js ditherThermal.
 *   ref: "abs"  — penalty = gain*heat (current raster.js)
 *        "tone" — penalty = gain*(heat − local target density): only heat in
 *                 excess of the steady state for this tone counts, so uniform
 *                 tones print exactly like plain dithering.
 *   refRadius: box radius for the local target density used by "tone".
 *   neg: allow negative penalty (cold head → model adds dots).
 *   tailRows/tailKeep: inside solid black, within tailRows rows above a light
 *                 area, fire only ~tailKeep (ramped) of dots on a Bayer mask to
 *                 cool the head before the edge.
 */
export function ditherModel(gray, w, h, opts = {}) {
  const p = { ...RASTER_DEFAULTS, kernel: "atkinson", serpentine: false, ref: "abs", refRadius: 2, neg: false,
    tailRows: 0, tailKeep: 1, ...opts };
  const K = KERNELS[p.kernel];
  const want = new Float32Array(w * h);
  for (let i = 0; i < want.length; i++) want[i] = 1 - gray[i] / 255;
  const visible = new Float32Array(w * h);
  for (let i = 0; i < visible.length; i++) visible[i] = Math.min(1, 2 * (1 - want[i]));
  const ref = p.ref === "tone" ? boxBlur(want, w, h, p.refRadius) : null;
  // rows to next light pixel below (for tail thinning)
  let toEdge = null;
  if (p.tailRows > 0) {
    toEdge = new Uint16Array(w * h);
    for (let x = 0; x < w; x++) {
      let d = 65535;
      for (let y = h - 1; y >= 0; y--) {
        const i = y * w + x;
        d = want[i] < 0.5 ? 0 : Math.min(65535, d + 1);
        toEdge[i] = d;
      }
    }
  }
  const bits = new Uint8Array(w * h);
  const fast = new Float32Array(w), slow = new Float32Array(w), tmp = new Float32Array(w);
  const advance = (heat, decay, row) => {
    for (let x = 0; x < w; x++) {
      const l = heat[x > 0 ? x - 1 : x], r = heat[x < w - 1 ? x + 1 : x];
      tmp[x] = (heat[x] * (1 - 2 * p.spread) + (l + r) * p.spread) * decay + (1 - decay) * bits[row + x];
    }
    heat.set(tmp);
  };
  for (let y = 0; y < h; y++) {
    const rev = p.serpentine && (y & 1);
    for (let xx = 0; xx < w; xx++) {
      const x = rev ? w - 1 - xx : xx, i = y * w + x;
      const heat = (1 - p.slowWeight) * fast[x] + p.slowWeight * slow[x];
      let ex = p.gain * (ref ? heat - ref[i] : heat);
      ex = Math.min(p.maxGain, Math.max(p.neg ? -p.maxGain : 0, ex)) * visible[i];
      const ifFired = 1 + ex, ifNot = Math.max(0, ex) * p.bleed;
      let fired;
      if (toEdge && want[i] >= 0.98 && gray[i] <= 5 && toEdge[i] <= p.tailRows) {
        // solid black near its bottom edge: ordered thinning, no error diffused
        const keep = p.tailKeep + (1 - p.tailKeep) * (toEdge[i] - 1) / p.tailRows;
        bits[i] = BAYER4[(y & 3) * 4 + (x & 3)] < keep * 16 ? 1 : 0;
        continue;
      }
      fired = want[i] > (ifFired + ifNot) / 2;
      bits[i] = fired ? 1 : 0;
      const e = want[i] - (fired ? ifFired : ifNot);
      for (const [dx, dy, wt] of K) {
        const tx = x + (rev ? -dx : dx), ty = y + dy;
        if (tx >= 0 && tx < w && ty < h) want[ty * w + tx] += e * wt;
      }
    }
    if (p.gain > 0) { advance(fast, p.fastDecay, y * w); advance(slow, p.slowDecay, y * w); }
  }
  return bits;
}

/**
 * "True" printer, deliberately a different parameterisation from the
 * compensator: 5-tap lateral diffusion, power-law dot gain, a separate smear
 * state for unfired paper, slow-heat fog, Gaussian dot spread, optical clamp.
 * Returns perceived darkness Float32Array (0 white .. 1 black).
 */
export const TRUE_NOMINAL = Object.freeze({
  G: 0.3, gamma: 1.0, aF: 0.7, aS: 0.985, wS: 0.5, s1: 0.12, s2: 0.03, S: 0.15, aM: 0.75, F: 0.03, sigma: 1.5,
});
export const TRUE_RANGES = Object.freeze({
  G: [0.1, 0.5], gamma: [0.7, 1.5], aF: [0.5, 0.85], aS: [0.97, 0.995], wS: [0.3, 0.7], s1: [0.05, 0.2],
  s2: [0, 0.05], S: [0.05, 0.3], aM: [0.6, 0.9], F: [0, 0.06], sigma: [1.2, 1.8],
});

export function simulatePrint(bits, w, h, T = TRUE_NOMINAL) {
  const t = { ...TRUE_NOMINAL, ...T };
  const D = new Float32Array(w * h);
  const fast = new Float32Array(w), slow = new Float32Array(w), smear = new Float32Array(w), tmp = new Float32Array(w);
  const c0 = 1 - 2 * t.s1 - 2 * t.s2;
  const step = (st, a, row) => {
    for (let x = 0; x < w; x++) {
      const g = (k) => st[Math.min(w - 1, Math.max(0, x + k))];
      tmp[x] = a * (c0 * st[x] + t.s1 * (g(-1) + g(1)) + t.s2 * (g(-2) + g(2))) + (1 - a) * bits[row + x];
    }
    st.set(tmp);
  };
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const he = (1 - t.wS) * fast[x] + t.wS * slow[x];
      D[row + x] = bits[row + x] ? 1 + t.G * Math.pow(he, t.gamma) : t.S * smear[x] + t.F * slow[x];
    }
    step(fast, t.aF, row); step(slow, t.aS, row); step(smear, t.aM, row);
  }
  const P = gaussBlur(D, w, h, t.sigma);
  for (let i = 0; i < P.length; i++) P[i] = Math.min(1, P[i]);
  return P;
}

/** Seeded random true-param sets spanning TRUE_RANGES. */
export function sampleTruths(n, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = [{ ...TRUE_NOMINAL }];
  for (let k = 1; k < n; k++) {
    const t = {};
    for (const [key, [lo, hi]] of Object.entries(TRUE_RANGES)) t[key] = lo + (hi - lo) * rnd();
    out.push(t);
  }
  return out;
}
