// Off-main-thread dithering so countdown/printing animations stay smooth.
// in:  { id, gray: Float32Array, w, h, segments: [{ y0, y1, opts }], copies = 1, sinkStart = 0 }
//      opts: ditherThermal options, plus `relief` for the solid-black relief
//      post-pass — a strength number (default 1, 0 = off) or relieveSolids opts.
//      copies > 1 renders each copy's relief from the head heat the previous
//      copy left behind (the head never cools between back-to-back copies).
// out: { id, bits: Uint8Array[] (one 0/1-per-pixel bitmap per copy), sink }
import { ditherThermal, relieveSolids } from "./raster.js";

self.onmessage = (e) => {
  const { id, gray, w, h, segments, copies = 1, sinkStart = 0 } = e.data;
  const segs = segments ?? [{ y0: 0, y1: h, opts: {} }];
  // The error-diffusion pass is the same for every copy; only relief differs.
  const base = segs.map((s) => ditherThermal(gray.subarray(s.y0 * w, s.y1 * w), w, s.y1 - s.y0, s.opts ?? {}));
  const state = { sink: sinkStart };
  const out = [];
  for (let c = 0; c < copies; c++) {
    const bits = new Uint8Array(w * h);
    segs.forEach((s, k) => {
      const r = (s.opts ?? {}).relief ?? 1;
      const ro = typeof r === "object" ? { ...r } : { strength: r };
      const b = r ? relieveSolids(base[k], w, s.y1 - s.y0, { ...ro, state }) : base[k];
      bits.set(b, s.y0 * w);
    });
    out.push(bits);
  }
  self.postMessage({ id, bits: out, sink: state.sink }, out.map((b) => b.buffer));
};
