// Metrics over simulated perceived prints (darkness 0..1).
import { boxBlur } from "./model.mjs";

export function regionMean(P, w, x0, y0, x1, y1) {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += P[y * w + x]; n++; }
  return s / n;
}

/** Calibration band: under-black minus right-side reference, same rows. */
export function calibMetrics(P, im) {
  const { w } = im, by = im.roi.by;
  const under = (a, b) => regionMean(P, w, 80, by + 100 + a, 360, by + 100 + b);
  const right = (a, b) => regionMean(P, w, 400, by + 100 + a, 540, by + 100 + b);
  const black = [];
  for (let y = by + 4; y < by + 96; y++) for (let x = 64; x < 376; x++) black.push(P[y * w + x]);
  black.sort((a, b) => a - b);
  return {
    ghost10: under(0, 10) - right(0, 10),
    ghost40: under(0, 40) - right(0, 40),
    ghost50band: regionMean(P, w, 80, by + 165, 360, by + 215) - regionMean(P, w, 400, by + 165, 540, by + 215),
    grey25: right(10, 55),          // reference grey level (darkness)
    blackP1: black[Math.floor(black.length * 0.01)],
  };
}

/** Pills: darkness of the 20 rows trailing each pill vs the background beside it. */
export function pillMetrics(P, im) {
  const { w } = im, [x0, b1, x1] = im.roi.pill1, [, b2] = im.roi.pill2;
  const inner = [];
  for (let y = 44; y < 50; y++) for (let x = 60; x < 300; x++) inner.push(P[y * w + x]);
  for (let y = 84; y < 89; y++) for (let x = 60; x < 300; x++) inner.push(P[y * w + x]);
  inner.sort((a, b) => a - b);
  return {
    smearWhite: regionMean(P, w, x0 + 30, b1 + 2, x1 - 30, b1 + 22) - regionMean(P, w, 400, b1 + 2, 540, b1 + 22),
    smearGrey: regionMean(P, w, x0 + 30, b2 + 2, x1 - 30, b2 + 22) - regionMean(P, w, 400, b2 + 2, 540, b2 + 22),
    pillBlackP1: inner[Math.floor(inner.length * 0.01)],
  };
}

function stats(a) {
  let m = 0; for (const v of a) m += v; m /= a.length;
  let s = 0; for (const v of a) s += (v - m) ** 2;
  return { mean: m, std: Math.sqrt(s / a.length) };
}

/**
 * Photo tone: compare a compensated print against the plain-Atkinson print
 * (the look the toneMap was tuned for) and against the target.
 *   bias      mean darkness difference vs plain (negative = lighter/washed out)
 *   contrast  std(box9 P) / std(box9 Pplain)
 *   localC    mean |box9 P − box25 P| / same for plain (local contrast, e.g. eyes vs cheek)
 *   mseT      MSE(box9 P, box9 target)
 */
export function photoMetrics(P, Pplain, target, w, h) {
  const a = boxBlur(P, w, h, 4), b = boxBlur(Pplain, w, h, 4);
  const t = new Float32Array(target.length);
  for (let i = 0; i < t.length; i++) t[i] = 1 - target[i] / 255;
  const tb = boxBlur(t, w, h, 4);
  const A = boxBlur(P, w, h, 12), B = boxBlur(Pplain, w, h, 12);
  let lc = 0, lcp = 0, mse = 0;
  for (let i = 0; i < a.length; i++) { lc += Math.abs(a[i] - A[i]); lcp += Math.abs(b[i] - B[i]); mse += (a[i] - tb[i]) ** 2; }
  const sa = stats(a), sb = stats(b);
  return { bias: sa.mean - sb.mean, contrast: sa.std / sb.std, localC: lc / lcp, mseT: mse / a.length };
}
