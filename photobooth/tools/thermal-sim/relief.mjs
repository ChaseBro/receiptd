// Source-side haze relief (raster.js relieveSolids) on the print art that
// hazes in real prints: dark photo bottom + outline + offset block, the big
// "№001", the date pill, the sunburst header. Reports trail-on-white before /
// after on every simulated "true" printer, photo tone vs gain 0, and writes
// contact sheets to out/.
//   node relief.mjs [nTruths=6] [--sweep]
import { ditherThermal, relieveSolids, DEFAULT_RELIEF } from "../../public/raster.js";
import { simulatePrint, sampleTruths, TRUE_NOMINAL } from "./model.mjs";
import { photos, strip, synthetic, W } from "./testset.mjs";
import { photoMetrics } from "./metrics.mjs";
import { encodePNG } from "./png.mjs";

const LIVE = { gain: 0.15, bleed: 0 };
const OUT = new URL("./out/", import.meta.url).pathname;

function canvas(h) { return { w: W, h, g: new Float32Array(W * h).fill(255) }; }
function paint(c, f, v) { for (let y = 0; y < c.h; y++) for (let x = 0; x < W; x++) if (f(x, y)) c.g[y * W + x] = v; }

// ---------- scenes (each with the trailing-edge ROI that hazes) ----------
function frame(name, photoAt, { odx = 10, ody = 10, line = 6 } = {}) {
  // as compose(): offset block (+10,+10), paper mat, photo, 6px outline → 10 black rows under the photo
  const c = canvas(420), x0 = 48, y0 = 30, pw = 470, ph = 260;
  paint(c, (x, y) => x >= x0 + odx && x < x0 + pw + odx && y >= y0 + ody && y < y0 + ph + ody, 0);
  paint(c, (x, y) => x >= x0 - 6 && x < x0 + pw + 6 && y >= y0 - 6 && y < y0 + ph + 6, 255);
  for (let y = y0; y < y0 + ph; y++) for (let x = x0; x < x0 + pw; x++) c.g[y * W + x] = photoAt(x - x0, y - y0);
  paint(c, (x, y) => x >= x0 - line && x < x0 + pw + line && y >= y0 - line && y < y0 + ph + line &&
    !(x >= x0 && x < x0 + pw && y >= y0 && y < y0 + ph), 0);
  const bottom = y0 + ph + Math.max(ody, line);
  return { name, ...c, trail: [x0 + 40, bottom, x0 + pw - 40], solid: [x0 + 40, y0 + ph + 1, x0 + pw - 40, bottom - 1] };
}
// dark clothes / shadow at the bottom of the photo (like the 3rd frame of the real strip)
const darkPhoto = (x, y) => Math.max(0, Math.min(255, 150 - 0.5 * y + 25 * Math.sin(x / 23) * Math.cos(y / 17)));
function realPhoto(ph) {
  // darkest real photo, bottom-aligned
  let best = ph[0], bm = 1e9;
  for (const p of ph) { let s = 0; for (let i = (p.h - 120) * p.w; i < p.h * p.w; i++) s += p.g[i]; if (s < bm) { bm = s; best = p; } }
  return (x, y) => best.g[Math.min(best.h - 1, best.h - 260 + y) * best.w + Math.min(best.w - 1, x + 40)];
}

// "№001" at 76px with ticketStub's offset shadow + 3px outline (glyph shapes approximated)
function numerals({ shadow = true } = {}) {
  const c = canvas(200), by = 40, H = 56;
  const ring = (cx, x, y) => { const u = (x - cx) / 23, v = (y - by - H / 2) / 29, u2 = (x - cx) / 10, v2 = (y - by - H / 2) / 16;
    return u * u + v * v <= 1 && u2 * u2 + v2 * v2 > 1; };
  const one = (cx, x, y) => (x >= cx - 7 && x < cx + 8 && y >= by && y < by + H) || (x >= cx - 16 && x < cx && y >= by && y < by + 12 && y - by < 12 - (cx - x) * 0.6);
  const numero = (x, y) => (x >= 300 && x < 312 && y >= by && y < by + H) || (x >= 336 && x < 348 && y >= by && y < by + H) ||
    (x >= 300 && x < 348 && y >= by && y < by + H && Math.abs((x - 300) - (y - by) * 48 / H) < 9) ||
    (((x - 362) / 9) ** 2 + ((y - by - 20) / 11) ** 2 <= 1 && ((x - 362) / 4) ** 2 + ((y - by - 20) / 6) ** 2 > 1) || (x >= 352 && x < 372 && y >= by + 38 && y < by + 44);
  const glyph = (x, y) => numero(x, y) || ring(400, x, y) || ring(456, x, y) || one(510, x, y);
  if (shadow) paint(c, (x, y) => glyph(x - 6, y - 6), 0);               // shadow
  paint(c, (x, y) => glyph(x, y), 255);                                 // white fill
  paint(c, (x, y) => { let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) n += glyph(x + dx, y + dy); return n > 0 && n < 9; }, 0); // outline
  return { name: "numerals", ...c, trail: [300, by + H + 7, 530], solid: [300, by, 530, by + H + 6] };
}
function pill({ outline = 0 } = {}) {
  const c = canvas(180), x0 = 34, x1 = 334, y0 = 40, y1 = 92, r = 26;
  paint(c, (x, y) => { if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; }, 0);
  if (outline) paint(c, (x, y) => { if (x < x0 + outline || x >= x1 - outline || y < y0 + outline || y >= y1 - outline) return false;
    const rr = r - outline, cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr; }, 255);
  for (let k = 0; k < 9; k++) paint(c, (x, y) => x >= 60 + k * 28 && x < 76 + k * 28 && y >= 52 && y < 80 && (k % 3 !== 2 || y > 60), outline ? 0 : 255);
  return { name: "datepill", ...c, trail: [x0 + 30, y1, x1 - 30], solid: [x0 + 30, y0, x1 - 30, y1] };
}
function sunburst({ fill = 0.35, fadeFrom = 999 } = {}) {
  const c = canvas(240), cx = W / 2, cy = 96, n = 28;
  paint(c, (x, y) => { if (y >= 150) return false; if (y >= fadeFrom && ((x + y) & 1)) return false; const a = (Math.atan2(y - cy, x - cx) + 2 * Math.PI) % (2 * Math.PI);
    const k = Math.floor(a / (2 * Math.PI / n)); const f = a / (2 * Math.PI / n) - k; return k % 2 === 0 && f < 2 * fill; }, 0);
  paint(c, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= 74 * 74, 255);
  return { name: "sunburst", ...c, trail: [0, 150, W], solid: [0, 130, W, 150] };
}

// ---------- metrics ----------
const mean = (P, x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += P[y * W + x]; n++; } return s / n; };
/** Haze on blank paper trailing the object: rows +4..+30 below its bottom (rows 1–3 are optical spread of the edge itself). */
function trail(P, im, bits) {
  const [x0, y, x1] = im.trail;
  let s = 0, n = 0;
  for (let yy = y + 4; yy < y + 30; yy++) for (let x = x0; x < x1; x++) { const i = yy * W + x; if (im.g[i] > 250 && !bits[i]) { s += P[i]; n++; } }
  return s / n;
}
function blackness(P, im) { const [x0, y0, x1, y1] = im.solid; const v = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (im.g[y * W + x] < 5) v.push(P[y * W + x]); v.sort((a, b) => a - b); return { mean: v.reduce((a, b) => a + b, 0) / v.length, p5: v[Math.floor(v.length * 0.05)] }; }
const density = (bits, im) => { const [x0, y0, x1, y1] = im.solid; let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (im.g[y * W + x] < 5) { s += bits[y * W + x]; n++; } return s / n; };

export function render(im, relief) {
  const b = ditherThermal(im.g, im.w, im.h, LIVE);
  return relief ? relieveSolids(b, im.w, im.h, relief) : b;
}

const args = process.argv.slice(2);
const nT = +(args.find((a) => /^\d+$/.test(a)) ?? 6);
const truths = sampleTruths(nT);
const thresh = [{ ...TRUE_NOMINAL, smTh: 0.5 }, { ...TRUE_NOMINAL, aM: 0.9, smTh: 0.5 }];
const ph = photos();
const SCENES = [frame("frame-dark", darkPhoto), frame("frame-real", realPhoto(ph)), numerals(), pill(), sunburst()];

function evalScenes(relief, T) {
  const r = {};
  for (const im of SCENES) {
    const bits = render(im, relief), P = simulatePrint(bits, im.w, im.h, T);
    r[im.name] = { trail: trail(P, im, bits), black: blackness(P, im), dens: density(bits, im) };
  }
  return r;
}
function avgOver(relief, Ts) {
  const all = Ts.map((T) => evalScenes(relief, T)), out = {};
  for (const k of Object.keys(all[0])) out[k] = {
    trail: all.reduce((s, a) => s + a[k].trail, 0) / all.length,
    blackMean: all.reduce((s, a) => s + a[k].black.mean, 0) / all.length,
    blackP5: Math.min(...all.map((a) => a[k].black.p5)), dens: all[0][k].dens,
  };
  return out;
}

const PHOTOS = [synthetic(), strip(ph), ...ph];
function photoTone(relief) {
  const acc = { bias: 0, mseT: 0, contrast: 0, localC: 0 }, Tn = truths.slice(0, 3);
  for (const T of Tn) for (const im of PHOTOS) {
    const P = simulatePrint(render(im, relief), im.w, im.h, T);
    const P0 = simulatePrint(ditherThermal(im.g, im.w, im.h, { gain: 0 }), im.w, im.h, T);
    const m = photoMetrics(P, P0, im.g, im.w, im.h);
    for (const k in acc) acc[k] += m[k] / (Tn.length * PHOTOS.length);
  }
  return acc;
}
function photoToneGain0() {
  let mse = 0; const Tn = truths.slice(0, 3);
  for (const T of Tn) for (const im of PHOTOS) {
    const P0 = simulatePrint(ditherThermal(im.g, im.w, im.h, { gain: 0 }), im.w, im.h, T);
    mse += photoMetrics(P0, P0, im.g, im.w, im.h).mseT / (Tn.length * PHOTOS.length);
  }
  return mse;
}

const f3 = (v) => v.toFixed(3);
function table(label, cur, prop) {
  console.log(`\n${label}`);
  console.log("scene        trail cur → new   (Δ%)    black mean cur → new   p5 new   solid density new");
  for (const k of Object.keys(cur)) {
    const a = cur[k], b = prop[k];
    console.log(`${k.padEnd(12)} ${f3(a.trail)} → ${f3(b.trail)}  (${(100 * (b.trail / a.trail - 1)).toFixed(0).padStart(4)}%)   ${f3(a.blackMean)} → ${f3(b.blackMean)}        ${f3(b.blackP5)}    ${f3(b.dens)}`);
  }
}

if (args.includes("--calib")) {
  // Real-printer calibration: the same art at relief strength 0 / 0.5 / 1 / 1.5 / 2,
  // already 1-bit (print with --dither threshold so nothing re-dithers it).
  // Band k is tagged by k+1 small squares at the left margin.
  const STR = [0, 0.5, 1, 1.5, 2], parts = [];
  const crop = (im, y0, y1) => ({ ...im, h: y1 - y0, g: im.g.subarray(y0 * W, y1 * W) });
  for (const [k, st] of STR.entries()) {
    for (const im of [crop(frame("f", darkPhoto), 150, 400), crop(numerals(), 20, 150), crop(pill(), 20, 140)]) {
      const b = Uint8Array.from(render(im, st ? { strength: st } : null));
      for (let q = 0; q <= k; q++) for (let y = 4; y < 12; y++) for (let x = 4 + q * 12; x < 12 + q * 12; x++) b[y * W + x] = 1;
      parts.push(b);
    }
    parts.push(new Uint8Array(W * 40)); // cool-down gap between strengths
  }
  const H = parts.reduce((s, p) => s + p.length / W, 0), pix = new Uint8Array(W * H);
  let o = 0; for (const p of parts) { for (let i = 0; i < p.length; i++) pix[o + i] = p[i] ? 0 : 255; o += p.length; }
  encodePNG(`${OUT}relief-calibration.png`, pix, W, H);
  console.log(`${OUT}relief-calibration.png  ${W}x${H}  strengths ${STR.join(" / ")}`);
  process.exit(0);
}

if (args.includes("--art")) {
  const pairs = [
    ["frame-dark", frame("frame-dark", darkPhoto), "offset block right-only (+10,0), 6px line", frame("x", darkPhoto, { ody: 0 })],
    ["frame-dark", frame("frame-dark", darkPhoto), "no offset block, 3px line", frame("x", darkPhoto, { odx: 0, ody: 0, line: 3 })],
    ["frame-real", frame("frame-real", realPhoto(ph)), "offset block right-only, 6px line", frame("x", realPhoto(ph), { ody: 0 })],
    ["numerals", numerals(), "outlined numerals, no shadow", numerals({ shadow: false })],
    ["datepill", pill(), "outlined pill (4px), black text", pill({ outline: 4 })],
    ["sunburst", sunburst(), "rays fill 0.25", sunburst({ fill: 0.25 })],
    ["sunburst", sunburst(), "rays 50% checker in last 30 rows", sunburst({ fadeFrom: 120 })],
  ];
  for (const [nm, a, label, b] of pairs) {
    b.trail = a.trail; // same ROI
    let ta = 0, tb = 0;
    for (const T of truths) {
      const ba = render(a, null), bb = render(b, null);
      ta += trail(simulatePrint(ba, a.w, a.h, T), a, ba) / truths.length; tb += trail(simulatePrint(bb, b.w, b.h, T), b, bb) / truths.length;
    }
    let tr = 0; for (const T of truths) { const bb = render(b, DEFAULT_RELIEF); tr += trail(simulatePrint(bb, b.w, b.h, T), b, bb) / truths.length; }
    console.log(`${nm.padEnd(11)} ${label.padEnd(40)} trail ${f3(ta)} → ${f3(tb)} (${(100 * (tb / ta - 1)).toFixed(0)}%)  +relief ${f3(tr)} (${(100 * (tr / ta - 1)).toFixed(0)}%)`);
  }
  process.exit(0);
}

if (args.includes("--sweep")) {
  for (const o of [{}, { keep: 0.92, edgeKeep: 0.8 }, { keep: 0.85, edgeKeep: 0.6 }, { keep: 0.8, edgeKeep: 0.5 }, { ramp: 8 }, { ramp: 32 },
    { tail: 2 }, { heatOn: 0.4 }, { heatOn: 0.8 }, { heatDecay: 0.95 }, { keep: 1, edgeKeep: 0.6 }]) {
    const m = avgOver({ ...DEFAULT_RELIEF, ...o }, truths), base = avgOver(null, truths);
    const red = Object.keys(m).map((k) => (100 * (1 - m[k].trail / base[k].trail)).toFixed(0).padStart(3)).join(" ");
    const bl = Math.min(...Object.values(m).map((v) => v.blackP5));
    console.log(JSON.stringify(o).padEnd(36), "trail cut % [", red, "] min black p5", f3(bl));
  }
  process.exit(0);
}

const cur = avgOver(null, truths), prop = avgOver(DEFAULT_RELIEF, truths);
table(`Linear haze, avg over ${truths.length} sampled printers (darkness 0=paper..1=black)`, cur, prop);
table("Threshold haze (haze only above 50% stored heat; aM .75 and .9)", avgOver(null, thresh), avgOver(DEFAULT_RELIEF, thresh));
const t0 = photoToneGain0(), tl = photoTone(null), tr = photoTone(DEFAULT_RELIEF);
console.log(`\nPhoto tone (${PHOTOS.length} images × 3 printers), MSE vs target (box9): gain0 ${t0.toFixed(5)}  live ${tl.mseT.toFixed(5)}  live+relief ${tr.mseT.toFixed(5)}`);
console.log(`  vs gain0 print: bias live ${tl.bias.toFixed(4)} / +relief ${tr.bias.toFixed(4)}; contrast ${tl.contrast.toFixed(3)} / ${tr.contrast.toFixed(3)}; localC ${tl.localC.toFixed(3)} / ${tr.localC.toFixed(3)}`);

// ---------- contact sheets: per scene, [1-bit current | sim current | 1-bit proposed | sim proposed] ----------
const T = { ...TRUE_NOMINAL, aM: 0.85 };
const gap = 8;
for (const im of [...SCENES, strip(ph)]) {
  const b0 = render(im, null), b1 = render(im, DEFAULT_RELIEF);
  const P0 = simulatePrint(b0, im.w, im.h, T), P1 = simulatePrint(b1, im.w, im.h, T);
  const cw = 4 * W + 3 * gap, pix = new Float32Array(cw * im.h).fill(160);
  [[b0, 1], [P0, 0], [b1, 1], [P1, 0]].forEach(([src, isBits], k) => {
    for (let y = 0; y < im.h; y++) for (let x = 0; x < W; x++) pix[y * cw + k * (W + gap) + x] = 255 * (1 - src[y * W + x]);
  });
  encodePNG(`${OUT}relief-${im.name}.png`, pix, cw, im.h);
}
console.log(`\ncontact sheets → ${OUT}relief-*.png  (columns: 1-bit current | simulated print current | 1-bit proposed | simulated print proposed)`);
