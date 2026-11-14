// Test images (gray 0=black..255=white, width 576).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { decodePNG } from "./png.mjs";
import { gaussBlur } from "./model.mjs";
import { toneMap } from "../../public/raster.js";

export const W = 576;

function canvas(h, v = 255) { return { w: W, h, g: new Float32Array(W * h).fill(v) }; }
function rect(c, x0, y0, x1, y1, f) {
  for (let y = Math.max(0, y0); y < Math.min(c.h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(c.w, x1); x++)
      c.g[y * c.w + x] = typeof f === "function" ? f(x, y) : f;
}
function roundRect(c, x0, y0, x1, y1, r, v) {
  rect(c, x0, y0, x1, y1, (x, y) => {
    const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r ? v : c.g[y * c.w + x];
  });
}

/** One band of public/frames.js calibrationGray (letter glyph → small block). */
export function calibration() {
  const c = canvas(300 + 40), y = 20;
  rect(c, 12, y + 30, 40, y + 70, 0);
  rect(c, 60, y, 380, y + 100, 0);
  rect(c, 60, y + 100, W - 20, y + 160, 191);
  rect(c, 60, y + 160, W - 20, y + 220, 128);
  rect(c, 60, y + 220, W - 20, y + 260, (x) => 255 * (1 - (x - 60) / (W - 80)));
  return { name: "calibration", ...c, roi: { by: y } };
}

/** Ticket-stub-like date pill (black, white "text" bars) on white, and a pill on 25% grey. */
export function pills() {
  const c = canvas(300);
  roundRect(c, 34, 40, 334, 92, 26, 0);
  for (let k = 0; k < 9; k++) rect(c, 60 + k * 28, 52, 76 + k * 28, 80, 255); // glyph-ish holes
  rect(c, 0, 160, W, 300, 191);
  roundRect(c, 34, 180, 334, 232, 26, 0);
  return { name: "pills", ...c, roi: { pill1: [34, 92, 334], pill2: [34, 232, 334] } };
}

function face(c, ox, oy, s, bg) {
  rect(c, ox, oy, ox + s, oy + s, (x, y) => {
    const u = (x - ox) / s - 0.5, v = (y - oy) / s - 0.5;
    let g = bg(u, v);
    const e = (u / 0.3) ** 2 + ((v - 0.05) / 0.4) ** 2;
    if (v < -0.18 && (u / 0.36) ** 2 + ((v + 0.12) / 0.38) ** 2 < 1) g = 40 + 25 * Math.sin(u * 40); // hair
    else if (e < 1) {
      g = 205 - 60 * Math.max(0, u + 0.1) - 30 * e;                           // shaded cheek
      for (const ex of [-0.11, 0.11]) if (((u - ex) / 0.06) ** 2 + ((v + 0.02) / 0.03) ** 2 < 1) g = 50;
      if ((u / 0.12) ** 2 + ((v - 0.22) / 0.03) ** 2 < 1) g = 110;           // mouth
    }
    return g;
  });
}

/** Ramps + face-like gradients, plus a frame-style black block above a grey photo region. */
export function synthetic() {
  const c = canvas(700);
  rect(c, 20, 10, W - 20, 70, (x) => 255 * (x - 20) / (W - 40));            // horizontal ramp
  rect(c, 20, 80, 140, 380, (x, y) => 255 * (y - 80) / 300);                  // vertical ramps
  rect(c, 150, 80, 270, 380, (x, y) => 255 * (1 - (y - 80) / 300));
  face(c, 280, 80, 280, (u, v) => 150 + 80 * v);
  // photo frame: 8px black outline + black offset block, light photo inside
  rect(c, 40, 410, 548, 690, 0);
  rect(c, 30, 400, 530, 680, 0);
  rect(c, 38, 408, 522, 672, (x, y) => 225 - 70 * ((y - 408) / 264) - 30 * Math.sin(x / 40));
  face(c, 150, 420, 240, (u, v) => 220 - 40 * (v + 0.5));
  return { name: "synthetic", ...c };
}

/** Real photos: already-dithered PNGs are descreened (σ=1.6) then tone-mapped like the booth. */
export function photos(dir = "/Users/chase/src/photo-receipts/img") {
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    let im;
    try { im = decodePNG(join(dir, f)); } catch { continue; }
    if (im.w !== W) continue;
    let binary = 0;
    for (const v of im.gray) if (v < 8 || v > 247) binary++;
    let g = im.gray;
    if (binary / g.length > 0.95) g = gaussBlur(g, im.w, im.h, 1.6);
    out.push({ name: f.slice(0, 8), w: im.w, h: im.h, g: toneMap(g), photo: true });
  }
  return out;
}

/** Real heat sources in the new print art: zig-zag edge, 6px outline + 10px offset block, partial offset block. */
export function edges() {
  const c = canvas(400, 200);
  rect(c, 0, 0, W, 4, 0);
  rect(c, 0, 4, W, 14, (x, y) => { const t = (x % 18) / 18, d = 10 * (1 - Math.abs(2 * t - 1)); return y - 4 < d ? 0 : 200; });
  rect(c, 0, 134, W, 150, 0);
  rect(c, 288, 270, W, 280, 0);
  return { name: "edges", ...c };
}

/** Flat skin/mid tones for texture (worms/maze) measurement. */
export function flats() {
  const c = canvas(480);
  [230, 200, 170, 128].forEach((v, k) => rect(c, 0, k * 120, W, (k + 1) * 120, v));
  return { name: "flats", ...c, levels: [230, 200, 170, 128] };
}

/** A strip-like composite: zig-zag, two framed real photos with offset blocks, date pill, bottom zig-zag. */
export function strip(ph) {
  const H = 20 + 2 * 300 + 160, c = canvas(H);
  rect(c, 0, 0, W, 4, 0);
  rect(c, 0, 4, W, 14, (x, y) => { const t = (x % 18) / 18, d = 10 * (1 - Math.abs(2 * t - 1)); return y - 4 < d ? 0 : 255; });
  for (let k = 0; k < 2; k++) {
    const src = ph[k % ph.length], x0 = 48, y0 = 40 + k * 300, pw = 480, phh = 260;
    rect(c, x0 + 10, y0 + 10, x0 + pw + 10, y0 + phh + 10, 0);           // offset block
    rect(c, x0 - 6, y0 - 6, x0 + pw + 6, y0 + phh + 6, 0);               // outline
    rect(c, x0, y0, x0 + pw, y0 + phh, (x, y) => src.g[(y - y0 + 20) * src.w + (x - x0 + 48)]);
  }
  roundRect(c, 34, H - 120, 334, H - 68, 26, 0);
  for (let k = 0; k < 9; k++) rect(c, 60 + k * 28, H - 108, 76 + k * 28, H - 80, 255);
  rect(c, 0, H - 4, W, H, 0);
  rect(c, 0, H - 14, W, H - 4, (x, y) => { const t = (x % 18) / 18, d = 10 * (1 - Math.abs(2 * t - 1)); return H - 4 - y <= d ? 0 : 255; });
  return { name: "strip", ...c, roi: { pill: [34, H - 68, 334] } };
}
