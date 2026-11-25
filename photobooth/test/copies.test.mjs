import test from "node:test";
import assert from "node:assert/strict";
import { clampCopies, defaultCopies, facesInFrame, maxFaces, MAX_COPIES, MIN_FACE_SCORE } from "../public/copies.js";

const face = (score) => ({ categories: [{ score }] });

test("clampCopies keeps integers in 1..6", () => {
  assert.equal(clampCopies(3), 3);
  assert.equal(clampCopies(0), 1);
  assert.equal(clampCopies(-4), 1);
  assert.equal(clampCopies(9), MAX_COPIES);
  assert.equal(clampCopies(2.6), 3);
  assert.equal(clampCopies("4"), 4);
  assert.equal(clampCopies(NaN), 1);
  assert.equal(clampCopies(undefined), 1);
  assert.equal(clampCopies(Infinity), 1);
});

test("facesInFrame counts confident detections only", () => {
  assert.equal(facesInFrame([face(0.9), face(MIN_FACE_SCORE), face(0.3)]), 2);
  assert.equal(facesInFrame([face(0.4)], 0.3), 1);
  assert.equal(facesInFrame([{}, null]), 0);
  assert.equal(facesInFrame(undefined), 0);
});

test("maxFaces takes the busiest frame; null when detection didn't run", () => {
  assert.equal(maxFaces([1, 3, 2]), 3);
  assert.equal(maxFaces([0, 0, 0]), 0);
  assert.equal(maxFaces([]), null);
  assert.equal(maxFaces(null), null);
});

test("defaultCopies: one per face, clamped to 1..6, 1 when unknown", () => {
  assert.equal(defaultCopies([2, 3, 1]), 3);
  assert.equal(defaultCopies([0, 0, 0]), 1);   // fake camera / nobody found
  assert.equal(defaultCopies([12]), MAX_COPIES);
  assert.equal(defaultCopies(null), 1);         // detector failed or slow
});

test("toBoxes keeps confident MediaPipe detections as {x,y,w,h,score}", async () => {
  const { toBoxes } = await import("../public/faces.js");
  const det = (score) => ({ categories: [{ score }], boundingBox: { originX: 10, originY: 20, width: 30, height: 40 } });
  assert.deepEqual(toBoxes([det(0.9), det(0.2), { categories: [{ score: 0.9 }] }]), [{ x: 10, y: 20, w: 30, h: 40, score: 0.9 }]);
  assert.deepEqual(toBoxes(undefined), []);
});

test("rotateBoxes follows a clockwise frame rotation", async () => {
  const { rotateBoxes } = await import("../public/faces.js");
  const b = [{ x: 10, y: 20, w: 30, h: 40, score: 1 }];   // in a 100×50 frame
  assert.deepEqual(rotateBoxes(b, 100, 50, 0), b);
  assert.deepEqual(rotateBoxes(b, 100, 50, 90), [{ x: 50 - 20 - 40, y: 10, w: 40, h: 30, score: 1 }]);
  assert.deepEqual(rotateBoxes(b, 100, 50, 180), [{ x: 100 - 10 - 30, y: 50 - 20 - 40, w: 30, h: 40, score: 1 }]);
  assert.deepEqual(rotateBoxes(b, 100, 50, 270), [{ x: 20, y: 100 - 10 - 30, w: 40, h: 30, score: 1 }]);
  // four quarter turns = identity
  let r = b; for (let i = 0; i < 4; i++) r = rotateBoxes(r, i % 2 ? 50 : 100, i % 2 ? 100 : 50, 90);
  assert.deepEqual(r, b);
});

test("startCopies: faces, raised to the start setting, capped at the kid max", async () => {
  const { startCopies, kidMax, KID_MAX_COPIES, START_COPIES } = await import("../public/copies.js");
  assert.equal(START_COPIES, 1); assert.equal(KID_MAX_COPIES, 3);
  assert.equal(startCopies(null), 1);
  assert.equal(startCopies([2, 1]), 2);
  assert.equal(startCopies([5]), 3, "kid max 3 by default");
  assert.equal(startCopies([5], 1, 6), 5);
  assert.equal(startCopies([1], 2, 3), 2, "start setting is a floor");
  assert.equal(startCopies([0], 4, 3), 3, "floor never beats the kid max");
  assert.equal(startCopies([9], 1, 99), 6, "hard cap 6");
  assert.equal(kidMax(0), 1); assert.equal(kidMax(12), 6);
});
