import test from "node:test";
import assert from "node:assert/strict";
import { printerHealth } from "../src/printer-status.ts";

const now = 1_800_000_000_000;
const snap = (statusCode, ago = 5) => JSON.stringify({ statusCode, lastSeenAt: now - ago * 1000 });

test("printer health from CloudPRNT status codes", () => {
  assert.equal(printerHealth(snap("410%20Out%20of%20paper"), now).paperOut, true);
  assert.equal(printerHealth(snap("410 Out of paper"), now).text, "410 Out of paper");
  assert.equal(printerHealth(snap("411%20Paper%20near%20end"), now).paperLow, true);
  assert.equal(printerHealth(snap("420 Cover open"), now).coverOpen, true);
  const ok = printerHealth(snap("200%20OK"), now);
  assert.deepEqual([ok.code, ok.paperOut, ok.error, ok.online], [200, false, false, true]);
  assert.equal(printerHealth(snap("520 Unknown"), now).error, true);
  assert.equal(printerHealth(snap("200 OK", 600), now).online, false);
  assert.equal(printerHealth(null, now).code, null);
  assert.equal(printerHealth("not json", now).online, false);
});
