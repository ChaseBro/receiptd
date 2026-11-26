import test from "node:test";
import assert from "node:assert/strict";
import { BETWEEN_SHOTS_S, CELEBRATE_MS, clampCountdown, COUNTDOWN_DEFAULT, COUNTDOWN_MAX, followMs, nudgeDue, PRINT_BEAT_MS, PRINT_HOLD_MS, printScreenDone, shotCountdown } from "../public/timing.js";

test("countdown defaults to instant; explicit choices 0..10 kept", () => {
  assert.equal(COUNTDOWN_DEFAULT, 0);
  assert.equal(clampCountdown(undefined), 0);   // fresh device: nothing stored
  assert.equal(clampCountdown(null), 0);
  assert.equal(clampCountdown(3), 3);           // a device that chose 3 s keeps it
  assert.equal(clampCountdown(0), 0);
  assert.equal(clampCountdown(1), 1);
  assert.equal(clampCountdown(99), COUNTDOWN_MAX);
  assert.equal(clampCountdown(-2), 0);
  assert.equal(clampCountdown("4"), 4);
  assert.equal(clampCountdown("nope"), 0);
});

test("shotCountdown: first shot as set, a posing beat between strip shots", () => {
  assert.deepEqual([0, 1, 2].map((i) => shotCountdown(0, i)), [0, BETWEEN_SHOTS_S, BETWEEN_SHOTS_S]);
  assert.deepEqual([0, 1, 2].map((i) => shotCountdown(3, i)), [3, 3, 3]);
  assert.equal(shotCountdown(undefined, 0), 0);
  assert.equal(BETWEEN_SHOTS_S, 1);
});

test("printing screen: never waits for the printer", () => {
  assert.equal(printScreenDone(0, ""), false);
  assert.equal(printScreenDone(PRINT_BEAT_MS - 1, "completed"), false, "a beat of animation even if it's instant");
  assert.equal(printScreenDone(PRINT_BEAT_MS, "completed"), true);
  assert.equal(printScreenDone(PRINT_HOLD_MS - 1, "queued"), false);
  assert.equal(printScreenDone(PRINT_HOLD_MS, "queued"), true, "still in line: leave anyway");
  assert.equal(printScreenDone(PRINT_HOLD_MS, undefined), true, "no reply at all: leave anyway");
  // From the 201 to the camera, at most hold + confetti: well under 10 s.
  assert.ok(PRINT_HOLD_MS + CELEBRATE_MS <= 8000);
});

test("background follow-up: nudge schedule and deadline", () => {
  assert.equal(followMs(1), 90000);
  assert.equal(followMs(3), 150000);
  assert.equal(nudgeDue(5000, 0, 1, 1000), false);
  assert.equal(nudgeDue(6001, 0, 1, 1000), true);
  assert.equal(nudgeDue(6001, 1, 1, 1000), false);
  assert.equal(nudgeDue(12001, 1, 1, 1000), true);
  assert.equal(nudgeDue(9e9, 5, 1, 1000), false, "at most 5");
  assert.equal(nudgeDue(6001, 0, 2, 1000), false, "extra copies add their print time");
});
