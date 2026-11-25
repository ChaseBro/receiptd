// Live print preview: the camera frame as the printer will dot it, off the main
// thread so the countdown ring never janks.
// init: { canvas: OffscreenCanvas }   (the on-screen #live canvas, transferred once)
// in:   { frame: ImageBitmap (already cover-cropped + scaled to w×h), w, h, gain }
// out:  { done: true, ms }            (main thread sends the next frame only after this)
//
// Same tone map + thermal dither + solid-black relief as the print (raster.js
// via dither.worker.js), but per photo tile: no face metering (centre-weighted),
// and the head heat starts cold at the top of the tile (the strip's header
// and the previous photos are not modelled).
import { luminance, toneMap, ditherThermal, relieveSolids } from "./raster.js";

let out = null, octx = null, scratch = null, sctx = null;

self.onmessage = (e) => {
  const d = e.data;
  if (d.canvas) { out = d.canvas; octx = out.getContext("2d"); return; }
  const t0 = performance.now();
  const { frame, w, h, gain } = d;
  try {
    if (!scratch || scratch.width !== w || scratch.height !== h) {
      scratch = new OffscreenCanvas(w, h);
      sctx = scratch.getContext("2d", { willReadFrequently: true });
    }
    sctx.drawImage(frame, 0, 0, w, h);
    frame.close();
    const img = sctx.getImageData(0, 0, w, h);
    const gray = toneMap(luminance(img.data, w, h), { width: w, height: h });
    const bits = relieveSolids(ditherThermal(gray, w, h, { gain, bleed: 0 }), w, h, { state: { sink: 0 } });
    // Tinted like the review preview (index.html drawBits): ink dots on paper.
    const px = img.data;
    for (let i = 0, j = 0; i < bits.length; i++, j += 4) {
      if (bits[i]) { px[j] = 26; px[j + 1] = 20; px[j + 2] = 35; } else { px[j] = 255; px[j + 1] = 249; px[j + 2] = 255; }
      px[j + 3] = 255;
    }
    if (out) {
      if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
      octx.putImageData(img, 0, 0);
    }
  } finally {
    self.postMessage({ done: true, ms: performance.now() - t0 });
  }
};
