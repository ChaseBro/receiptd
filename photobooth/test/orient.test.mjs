import test from "node:test";
import assert from "node:assert/strict";
import { deviceRotation, uprightRotation } from "../public/orient.js";

test("device rotation from tilt", () => {
  assert.equal(deviceRotation(90, 0), 0);      // upright portrait
  assert.equal(deviceRotation(70, 5), 0);      // portrait, leaning back
  assert.equal(deviceRotation(0, 90), 90);     // turned clockwise (right edge down)
  assert.equal(deviceRotation(0, -90), 270);   // turned counter-clockwise
  assert.equal(deviceRotation(-90, 0), 180);   // upside down
  assert.equal(deviceRotation(10, 65), 90);    // iPad landscape leaning back on its stand
  assert.equal(deviceRotation(-10, -65), 270);
  assert.equal(deviceRotation(170, 70), 270);  // near-gimbal reading: still a clean quarter turn
  assert.equal(deviceRotation(2, 3), null);    // flat on a table
});

test("page rotating with the device needs no correction (any screen angle)", () => {
  assert.equal(uprightRotation({ beta: 10, gamma: 65 }, true, 270), 0);
  assert.equal(uprightRotation({ beta: 10, gamma: 65 }, true, 0), 0);    // iPad Safari reporting 0° in landscape
  assert.equal(uprightRotation({ beta: -10, gamma: -65 }, true, 90), 0);
  assert.equal(uprightRotation({ beta: 85, gamma: 0 }, false, 0), 0);
});

test("orientation-locked portrait page corrects by the device turn", () => {
  assert.equal(uprightRotation({ beta: 10, gamma: 65 }, false, 0), 90);
  assert.equal(uprightRotation({ beta: -10, gamma: -65 }, false, 0), 270);
});

test("no sensor or flat → trust the frame", () => {
  assert.equal(uprightRotation(null, true, 90), 0);
  assert.equal(uprightRotation({ beta: 1, gamma: 1 }, false, 90), 0);
});
