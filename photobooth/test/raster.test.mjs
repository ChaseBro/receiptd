import test from "node:test";
import assert from "node:assert/strict";
import { ditherThermal, packBits } from "../public/raster.js";

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
