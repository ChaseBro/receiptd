// Sanity: ditherModel == raster.js ditherThermal for raster-compatible options.
import { ditherThermal } from "../../public/raster.js";
import { ditherModel } from "./model.mjs";
import { calibration, photos, pills, edges } from "./testset.mjs";
const ims = [calibration(), pills(), edges(), ...photos()];
for (const o of [{}, { gain: 0 }, { gain: 0.15, bleed: 0 }]) for (const im of ims) {
  const t0 = performance.now();
  const a = ditherThermal(im.g, im.w, im.h, o), b = ditherModel(im.g, im.w, im.h, o);
  let d = 0; for (let i = 0; i < a.length; i++) d += a[i] !== b[i];
  if (d) { console.log("MISMATCH", im.name, o, d); process.exit(1); }
}
console.log("ok: ditherModel bit-identical to raster.js on", ims.length, "images x 3 option sets");
