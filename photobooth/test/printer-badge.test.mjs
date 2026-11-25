// The camera badge: /api/printer → one drawn state each (public/printer-state.js), adult labels.
import test from "node:test";
import assert from "node:assert/strict";
import { printerHealth } from "../src/printer-status.ts";
import { needsAdult, printerHint, printerState, STATE_ICON, statusWords } from "../public/printer-state.js";
import { CLASSIC, DRAWN, drawnSVG, iconHTML, ICON_NAMES } from "../public/icons.js";

const now = 1_800_000_000_000;
const h = (statusCode, ago = 5) => printerHealth(JSON.stringify({ statusCode, lastSeenAt: now - ago * 1000 }), now);

test("each printer problem maps to its own state (and badge)", () => {
  assert.equal(printerState(h("200 OK")), "ready");
  assert.equal(printerState(h("200 OK", 600)), "offline", "stale lastSeen = offline");
  assert.equal(printerState(printerHealth(null, now)), "offline", "never seen = offline");
  assert.equal(printerState(h("410 Out of paper", 600)), "offline", "offline wins: the paper status is stale");
  assert.equal(printerState(h("410%20Out%20of%20paper")), "paperOut");
  assert.equal(printerState(h("420 Cover open")), "cover");
  assert.equal(printerState(h("520 Unknown")), "error");
  assert.equal(printerState(h("411 Paper near end")), "paperLow");
  assert.equal(printerState(null), null, "no answer yet: no badge");
  // Distinct drawings; cover-open and error are no longer the same sticker.
  const icons = ["offline", "paperOut", "cover", "error", "paperLow", "ready"].map((s) => STATE_ICON[s]);
  assert.equal(new Set(icons).size, icons.length);
  for (const i of icons) assert.ok(DRAWN[i] && CLASSIC[i], i);
  const classic = ["offline", "paperOut", "cover", "error"].map((s) => CLASSIC[STATE_ICON[s]]);
  assert.equal(new Set(classic).size, 4, "Classic badge emoji are distinct too");
});

test("the badge shows only when a grown-up is needed", () => {
  assert.deepEqual(["offline", "paperOut", "cover", "error", "paperLow", "ready", null].map(needsAdult), [true, true, true, true, false, false, false]);
});

test("adult labels: short, with the last-seen time when offline", () => {
  const off = printerHint(h("200 OK", 600), now);
  assert.match(off, /^Printer offline · last seen \d{1,2}:\d\d (am|pm) · Check its power & Wi-Fi$/);
  assert.match(printerHint(printerHealth(null, now), now), /not seen yet/);
  assert.equal(printerHint(h("410 Out of paper"), now), "Out of paper");
  assert.equal(printerHint(h("420 Cover open"), now), "Cover open");
  assert.equal(printerHint(h("500 Boom"), now), "Printer error — turn it off and on");
  const w = statusWords(h("411 Paper near end"), now);
  assert.deepEqual([w.printer[0], w.paper[0]], ["Printer ready", "Paper low"]);
  assert.equal(statusWords(h("200 OK", 900), now).stale, true);
});

test("every icon has a drawing and a Classic fallback; SVG is well formed", () => {
  for (const n of ICON_NAMES) {
    const svg = drawnSVG(n);
    assert.match(svg, /^<svg class="ic" viewBox="0 0 100 100" aria-hidden="true"/);
    assert.ok(!/NaN|undefined/.test(svg), `${n} draws cleanly`);
    assert.equal((svg.match(/<svg/g) || []).length, (svg.match(/<\/svg>/g) || []).length);
    assert.ok(iconHTML(n, "classic").length > 0, `${n} has a Classic look`);
  }
  assert.match(drawnSVG("queue", 4), />4<\/text>/, "in-line badge carries the number");
});
