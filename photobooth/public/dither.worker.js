// Off-main-thread dithering so countdown/printing animations stay smooth.
// in:  { id, gray: Float32Array, w, h, segments: [{ y0, y1, opts }] }
// out: { id, bits: Uint8Array (0/1 per pixel) }
import { ditherThermal } from "./raster.js";

self.onmessage = (e) => {
  const { id, gray, w, h, segments } = e.data;
  const bits = new Uint8Array(w * h);
  for (const s of segments ?? [{ y0: 0, y1: h, opts: {} }]) {
    const slice = gray.subarray(s.y0 * w, s.y1 * w);
    bits.set(ditherThermal(slice, w, s.y1 - s.y0, s.opts), s.y0 * w);
  }
  self.postMessage({ id, bits }, [bits.buffer]);
};
