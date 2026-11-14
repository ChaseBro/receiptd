// Shared evaluation: dither every test image with a compensator, print it on
// each "true" printer, and collect metrics (averaged + worst case over truths).
import { ditherModel, simulatePrint } from "./model.mjs";
import { calibration, pills, edges, flats, synthetic, photos, strip } from "./testset.mjs";
import { calibMetrics, pillMetrics, edgeMetrics, textureMetrics, photoMetrics } from "./metrics.mjs";

const ph = photos();
export const IMAGES = { calibration: calibration(), pills: pills(), edges: edges(), flats: flats(), synthetic: synthetic(), strip: strip(ph) };
export const PHOTOS = [IMAGES.synthetic, IMAGES.strip, ...ph];

const plainCache = new Map();
function plainPrint(im, T, ti) {
  const k = im.name + ti;
  if (!plainCache.has(k)) plainCache.set(k, simulatePrint(ditherModel(im.g, im.w, im.h, { gain: 0 }), im.w, im.h, T));
  return plainCache.get(k);
}

export function evaluate(opts, truths, { photosToo = true } = {}) {
  const per = truths.map((T, ti) => {
    const run = (im) => simulatePrint(ditherModel(im.g, im.w, im.h, opts), im.w, im.h, T);
    const r = { ...calibMetrics(run(IMAGES.calibration), IMAGES.calibration), ...pillMetrics(run(IMAGES.pills), IMAGES.pills),
      ...edgeMetrics(run(IMAGES.edges), IMAGES.edges), ...textureMetrics(run(IMAGES.flats), IMAGES.flats) };
    if (photosToo) {
      const pm = PHOTOS.map((im) => photoMetrics(run(im), plainPrint(im, T, ti), im.g, im.w, im.h));
      for (const k of ["bias", "contrast", "localC", "mseT"]) {
        r[k] = pm.reduce((s, m) => s + m[k], 0) / pm.length;
        r[k + "Worst"] = k === "mseT" ? Math.max(...pm.map((m) => m[k])) : Math.min(...pm.map((m) => m[k]));
      }
    }
    return r;
  });
  const avg = {}, worst = {};
  for (const k of Object.keys(per[0])) {
    const v = per.map((r) => r[k]);
    avg[k] = v.reduce((a, b) => a + b, 0) / v.length;
    worst[k] = v.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
  }
  return { avg, worst, per };
}

/** Lower is better. Ghost terms are in perceived-darkness units (0..1). */
export function score(m) {
  const a = m.avg;
  const ghost = Math.abs(a.ghost10) + Math.abs(a.ghost40) + Math.abs(a.ghost50band) + Math.abs(a.gZig) + Math.abs(a.gBlock) + Math.abs(a.gOffset) + 0.5 * a.smearGrey;
  const tone = 4 * Math.max(0, -a.bias) + 2 * Math.max(0, 1 - a.contrast) + 2 * Math.max(0, 1 - a.localC);
  const holes = 4 * Math.max(0, 0.97 - a.blackP1) + 4 * Math.max(0, 0.97 - a.pillBlackP1);
  return ghost + tone + holes + 0.5 * a.tex;
}
