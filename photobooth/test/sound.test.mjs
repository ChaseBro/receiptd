import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { renderWav } from "../public/sound.js";

test("renderWav produces a valid mono 16-bit PCM WAV", async () => {
  const blob = renderWav([{ f: 440, dur: 0.1, type: "square", vol: 0.2 }]);
  const b = new DataView(await blob.arrayBuffer());
  const s = (o, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => b.getUint8(o + i)));
  assert.equal(s(0, 4), "RIFF"); assert.equal(s(8, 4), "WAVE"); assert.equal(s(36, 4), "data");
  assert.equal(b.getUint16(22, true), 1);   // mono
  assert.equal(b.getUint16(34, true), 16);  // 16-bit
  assert.equal(b.byteLength, 44 + b.getUint32(40, true));
});

test("kid flow never calls permission-prompting APIs (camera aside)", () => {
  // Web Audio prompted for the mic on iOS with the camera live; tilt sensor
  // prompted for Motion & Orientation mid-countdown. Keep them out.
  const dir = new URL("../public/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => /\.(html|js)$/.test(n) && n !== "orient.js")) {
    const src = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/\bAudioContext\b|webkitAudioContext/.test(src), `${f} uses Web Audio`);
    // Motion permission may only be requested at PIN unlock, never in capture.
    const asks = src.match(/requestPermission\s*\(/g) ?? [];
    assert.ok(asks.length <= 1, `${f} requests permissions in several places`);
    if (asks.length) assert.match(src, /async function askMotionAtUnlock[\s\S]*requestPermission/, `${f}: only askMotionAtUnlock may ask`);
    const calls = src.match(/(?<!function )askMotionAtUnlock\(\)/g) ?? [];
    assert.ok(calls.length <= 1, `${f} asks for motion outside the unlock form`);
    if (calls.length) assert.match(src, /lockForm[^]*?onsubmit[^]*?askMotionAtUnlock\(\)/, `${f}: motion asked outside unlock`);
    assert.ok(!/devicemotion/i.test(src), `${f} uses devicemotion`);
    assert.ok(!/getUserMedia\(\s*\{[^}]*audio:\s*true/.test(src), `${f} requests the microphone`);
  }
});
