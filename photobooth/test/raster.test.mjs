import test from "node:test";
import assert from "node:assert/strict";
import { ditherThermal, packBits, relieveSolids, DEFAULT_RELIEF } from "../public/raster.js";

const W = 576;
// 120 rows solid black, then 240 rows of 25% grey (gray=191).
function blackThenGrey() {
  const h = 360, g = new Float32Array(W * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) g[y * W + x] = y < 120 ? 0 : 191;
  return { g, h };
}
const density = (bits, y0, y1) => {
  let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) n += bits[y * W + x];
  return n / ((y1 - y0) * W);
};

test("gain 0 is plain Atkinson: grey density ≈ target", () => {
  const { g, h } = blackThenGrey();
  const b = ditherThermal(g, W, h, { gain: 0 });
  assert.equal(density(b, 0, 120), 1);
  const d = density(b, 200, 360);
  assert.ok(d > 0.14 && d < 0.3, `grey density ${d}`); // Atkinson drops 1/4 of error → lighter
});

test("thermal model thins dots right after the black block (anti-ghost)", () => {
  const { g, h } = blackThenGrey();
  const plain = ditherThermal(g, W, h, { gain: 0 });
  const comp = ditherThermal(g, W, h, { gain: 0.3 });
  const near = density(comp, 120, 140), far = density(comp, 300, 360);
  console.log({ plainNear: density(plain, 120, 140), compNear: near, compFar: far, compBlack: density(comp, 0, 120) });
  assert.ok(near < density(plain, 120, 140) - 0.03, "fewer dots just below the black");
  assert.ok(near < far, "density recovers as the head cools");
  assert.ok(density(comp, 0, 120) > 0.99, "solid black stays black");
});

test("packBits MSB-first, 1 = black", () => {
  const bits = new Uint8Array(W); bits[0] = 1; bits[9] = 1;
  const p = packBits(bits, W, 1);
  assert.equal(p.length, 72); assert.equal(p[0], 0x80); assert.equal(p[1], 0x40);
});

// ---- solid-black relief (source-side fix for haze on white paper) ----
function shapes() {
  // 80-row solid band, then white; a 2px vertical rule and a 1px horizontal rule on white.
  const h = 200, b = new Uint8Array(W * h);
  for (let y = 20; y < 100; y++) for (let x = 40; x < 400; x++) b[y * W + x] = 1;
  for (let y = 20; y < 180; y++) for (let x = 480; x < 482; x++) b[y * W + x] = 1;
  for (let x = 0; x < W; x++) b[150 * W + x] = 1;
  return { b, h };
}
const dens = (b, x0, x1, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += b[y * W + x]; return n / ((x1 - x0) * (y1 - y0)); };

test("relieveSolids: caps sustained solids, thins harder before the trailing edge", () => {
  const { b, h } = shapes(), r = relieveSolids(b, W, h);
  const top = dens(r, 42, 398, 20, 26), mid = dens(r, 42, 398, 50, 70), last = dens(r, 42, 398, 92, 100);
  console.log({ top, mid, last });
  assert.ok(top > 0.97, `cold leading rows stay solid (${top})`);
  assert.ok(Math.abs(mid - DEFAULT_RELIEF.keep) < 0.03, `interior ≈ keep (${mid})`);
  assert.ok(last < mid - 0.08 && last > DEFAULT_RELIEF.edgeKeep - 0.05, `ramped tail (${last})`);
  // holes are spread over every heater element (column), not clumped
  for (let x = 42; x < 398; x++) assert.ok(dens(r, x, x + 1, 40, 100) < 0.97, `column ${x} gets rests`);
});

test("relieveSolids: never touches thin lines, edges, white paper or greys", () => {
  const { b, h } = shapes(), r = relieveSolids(b, W, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!b[i]) assert.equal(r[i], 0, "never adds dots");
    const edge = x === 40 || x === 399 || (x >= 480 && x < 482) || y === 150;
    if (edge) assert.equal(r[i], b[i], `kept ${x},${y}`);
  }
  const { g, h: gh } = blackThenGrey();
  const grey = ditherThermal(g, W, gh, { gain: 0.15, bleed: 0 });
  const rg = relieveSolids(grey, W, gh);
  assert.deepEqual(rg.subarray(200 * W), grey.subarray(200 * W), "25% grey untouched");
});

test("relieveSolids: strength 0 is identity, strength scales, deterministic", () => {
  const { b, h } = shapes();
  assert.deepEqual(relieveSolids(b, W, h, { strength: 0 }), b);
  const r1 = relieveSolids(b, W, h), r2 = relieveSolids(b, W, h, { strength: 2 });
  assert.ok(dens(r2, 42, 398, 40, 100) < dens(r1, 42, 398, 40, 100) - 0.05);
  assert.deepEqual(relieveSolids(b, W, h), r1);
  assert.equal(b[50 * W + 100], 1, "input not mutated");
});

// ---- toneMap ---------------------------------------------------------------
import { toneMap } from "../public/raster.js";
import { coverCrop, facesToTile } from "../public/frames.js";

const TW = 160, TH = 120;
const FACE = { x: 60, y: 30, w: 40, h: 50 };
let seed = 3;
const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 8;
/** Bright window (≈240) behind a dark kid: face ≈ 50, hoodie ≈ 20 with folds. */
function backlit() {
  const g = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    let v = 236 + 6 * Math.sin(y / 3);
    if (y > 80 && x > 40 && x < 120) v = 20 + 8 * Math.sin(x / 2);
    if (x >= FACE.x && x < FACE.x + FACE.w && y >= FACE.y && y < FACE.y + FACE.h) v = 50;
    g[y * TW + x] = Math.max(0, Math.min(255, v + noise()));
  }
  return g;
}
const medianBox = (g, b) => {
  const a = [];
  for (let y = b.y + b.h * 0.2; y < b.y + b.h * 0.8; y++) for (let x = b.x + b.w * 0.2; x < b.x + b.w * 0.8; x++) a.push(g[(y | 0) * TW + (x | 0)]);
  return a.sort((p, q) => p - q)[a.length >> 1];
};

test("toneMap: backlit face is metered up to light skin", () => {
  const g = backlit();
  const withFace = toneMap(g, { width: TW, height: TH, faces: [FACE] });
  const without = toneMap(g, { width: TW, height: TH });
  const m = medianBox(withFace, FACE);
  console.log({ faceWith: m, faceWithout: medianBox(without, FACE), legacyStyle: medianBox(toneMap(g), FACE) });
  assert.ok(m > 140 && m < 185, `face median ${m}`);
  assert.ok(m > medianBox(without, FACE) + 40, "faces drive exposure");
});

test("toneMap: window keeps faint texture (shoulder), hoodie keeps folds (toe)", () => {
  const out = toneMap(backlit(), { width: TW, height: TH, faces: [FACE] });
  let win = 0, nWin = 0, lo = 255, hi = 0;
  for (let y = 0; y < 25; y++) for (let x = 0; x < TW; x++) { nWin++; if (out[y * TW + x] < 254) win++; }
  for (let y = 90; y < TH; y++) for (let x = 50; x < 110; x++) { const v = out[y * TW + x]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(win / nWin > 0.9, `window pixels below paper white: ${win / nWin}`);
  assert.ok(lo > 20, `hoodie floor ${lo} (Atkinson prints <~30 as solid)`);
  assert.ok(hi - lo > 20, `hoodie fold range ${hi - lo}`);
});

test("toneMap: flat white stays paper, flat black stays dark, no NaN", () => {
  for (const opts of [undefined, { width: 20, height: 10 }, { width: 20, height: 10, faces: [{ x: 2, y: 2, w: 8, h: 6 }] }]) {
    assert.ok(toneMap(new Float32Array(200).fill(255), opts).every((v) => v === 255), "white");
    assert.ok(toneMap(new Float32Array(200).fill(0), opts).every((v) => v < 40), "black");
    const grey = toneMap(new Float32Array(200).fill(128), opts);
    assert.ok(grey.every((v) => Number.isFinite(v) && v > 60 && v < 200), "grey");
  }
  const rnd = Float32Array.from({ length: TW * TH }, (_, i) => (i * 7919) % 256);
  const odd = [{ x: -50, y: -50, w: 10, h: 10 }, { x: 500, y: 0, w: 5, h: 5 }, { x: NaN, y: 0, w: 4, h: 4 }, null, { x: 0, y: 0, w: 0, h: 9 }];
  for (const out of [toneMap(rnd), toneMap(rnd, { width: TW, height: TH, faces: odd }), toneMap(new Float32Array(0))]) {
    assert.ok(out.every((v) => Number.isFinite(v) && v >= 0 && v <= 255));
  }
});

test("toneMap: one-arg call is backward compatible and monotone", () => {
  const ramp = Float32Array.from({ length: 256 }, (_, i) => i);
  const out = toneMap(ramp);
  assert.equal(out.length, 256);
  for (let i = 1; i < 256; i++) assert.ok(out[i] >= out[i - 1] - 1e-3, `monotone at ${i}`);
  assert.ok(out[0] < 40 && out[255] === 255);
});

test("toneMap: 3 phone-sized tiles well under budget", () => {
  const g = Float32Array.from({ length: 528 * 396 }, (_, i) => (i % 528) * 0.4 + ((i / 528) | 0) * 0.1);
  toneMap(g, { width: 528, height: 396 });
  const t0 = performance.now();
  for (let k = 0; k < 3; k++) toneMap(g, { width: 528, height: 396, faces: [{ x: 200, y: 100, w: 120, h: 150 }] });
  const ms = performance.now() - t0;
  console.log({ threeTilesMs: ms.toFixed(1) });
  assert.ok(ms < 150, `${ms} ms`);
});

test("facesToTile maps frame boxes through the cover-crop", () => {
  // 1280×720 frame into a 4:3 slot of 400×300: crop is 960×720 centred (sx=160)
  const crop = coverCrop(1280, 720, 400, 300);
  assert.deepEqual([crop.sx, crop.sy, crop.sw, crop.sh], [160, 0, 960, 720]);
  const [f] = facesToTile([{ x: 640, y: 360, w: 96, h: 72 }], crop, 400, 300);
  assert.deepEqual([f.x, f.y, f.w, f.h].map((v) => +v.toFixed(3)), [200, 150, 40, 30]);
  // box straddling the left crop edge is clipped; one fully outside is dropped
  const [g] = facesToTile([{ x: 100, y: 0, w: 120, h: 72 }, { x: 0, y: 0, w: 100, h: 100 }], crop, 400, 300);
  assert.equal(facesToTile([{ x: 0, y: 0, w: 100, h: 100 }], crop, 400, 300).length, 0);
  assert.ok(g.x === 0 && Math.abs(g.w - 25) < 1e-9);
  assert.deepEqual(facesToTile(undefined, crop, 400, 300), []);
});

test("relieveSolids: head-wide heat thins long dark runs more as the head warms", () => {
  // 1600 rows of a wide dark band (cols 40..535) with a white margin.
  const h = 1600, b = new Uint8Array(W * h);
  for (let y = 0; y < h; y++) for (let x = 40; x < 536; x++) b[y * W + x] = 1;
  const r = relieveSolids(b, W, h);
  const early = dens(r, 60, 516, 100, 200), late = dens(r, 60, 516, 1300, 1400);
  console.log({ early, late });
  assert.ok(late < early - 0.08, `warm head thins more (${early} → ${late})`);
  assert.ok(late > 0.6, `still reads as black (${late})`);
  const off = relieveSolids(b, W, h, { sinkGain: 0 });
  assert.ok(Math.abs(dens(off, 60, 516, 1300, 1400) - dens(off, 60, 516, 100, 200)) < 0.03, "sinkGain 0 → no slow drift");
});

test("relieveSolids: head heat carries over between back-to-back copies", () => {
  const h = 800, b = new Uint8Array(W * h);
  for (let y = 0; y < h; y++) for (let x = 40; x < 536; x++) b[y * W + x] = 1;
  const state = { sink: 0 };
  const c1 = relieveSolids(b, W, h, { state });
  const after1 = state.sink;
  const c2 = relieveSolids(b, W, h, { state });
  console.log({ after1, after2: state.sink, d1: dens(c1, 60, 516, 50, 150), d2: dens(c2, 60, 516, 50, 150) });
  assert.ok(after1 > 0.3, `first copy warms the head (${after1})`);
  assert.ok(dens(c2, 60, 516, 50, 150) < dens(c1, 60, 516, 50, 150) - 0.05, "second copy starts thinner");
  assert.ok(state.sink >= after1, "keeps warming");
});
