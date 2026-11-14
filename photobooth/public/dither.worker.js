// Off-main-thread dithering so countdown/printing animations stay smooth.
// in:  { id, gray: Float32Array, w, h, segments: [{ y0, y1, opts }] }
//      opts: ditherThermal options, plus `relief` for the solid-black relief
//      post-pass — a strength number (default 1, 0 = off) or relieveSolids opts.
// out: { id, bits: Uint8Array (0/1 per pixel) }
import { ditherThermal, relieveSolids } from "./raster.js";

self.onmessage = (e) => {
  const { id, gray, w, h, segments } = e.data;
  const bits = new Uint8Array(w * h);
  for (const s of segments ?? [{ y0: 0, y1: h, opts: {} }]) {
    const rows = s.y1 - s.y0, opts = s.opts ?? {};
    const r = opts.relief ?? 1;
    let b = ditherThermal(gray.subarray(s.y0 * w, s.y1 * w), w, rows, opts);
    if (r) b = relieveSolids(b, w, rows, typeof r === "object" ? r : { strength: r });
    bits.set(b, s.y0 * w);
  }
  self.postMessage({ id, bits }, [bits.buffer]);
};
