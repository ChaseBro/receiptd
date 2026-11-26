// crop.mjs in.png out.png y0 y1 [x0 x1] [scale] — tail crops for looking at the QR band
import { decodePNG, encodePNG } from "../thermal-sim/png.mjs";
const [inp, out, y0, y1, x0 = 0, x1, k = 1] = process.argv.slice(2);
const im = decodePNG(inp), X1 = +(x1 ?? im.w), s = +k;
const w = (X1 - x0) * s, h = (y1 - y0) * s, o = new Float32Array(w * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = im.gray[(+y0 + Math.floor(y / s)) * im.w + +x0 + Math.floor(x / s)];
encodePNG(out, o, w, h);
