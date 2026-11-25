// The redesign: drawn icons (Drawn / Classic), the settings gear (press and hold), make another
// booth (hold), the printer badge + its adult label, the reorganised settings sheet, new settings.
//   BASE=http://localhost:8788 PIN=1234 node e2e/redesign.e2e.mjs      (local booth only)
// Screenshots → ios/build/shots/redesign/web-*.png (gitignored).
import { chromium, devices } from "playwright";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8788";
const PIN = process.env.PIN ?? "1234";
if (/receiptd\.sh/.test(BASE) && !process.env.ALLOW_REMOTE) throw new Error("local booth only");
const OUT = new URL("../ios/build/shots/redesign/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const log = (m) => console.log("  ok ", m);
const ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];

const browser = await chromium.launch({ args: ARGS });
async function booth(dev, seed = {}, printer = null) {
  const ctx = await browser.newContext({ permissions: ["camera"], ...dev });
  await ctx.addInitScript(([pin, seed]) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("booth.pin", JSON.stringify(pin)); localStorage.setItem("booth.sound", "false");
    for (const [k, v] of Object.entries(seed)) localStorage.setItem("booth." + k, JSON.stringify(v));
  }, [PIN, seed]);
  // The local booth has no printer polling it (always "offline"); fake a status where a test needs one.
  if (printer) await ctx.route("**/api/printer", (r) => r.fulfill({ json: printer }));
  const page = await ctx.newPage();
  page.errs = [];
  page.on("pageerror", (e) => page.errs.push(e.message));
  await page.goto(BASE + "/");
  await page.locator("#cam.on").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.getElementById("video").videoWidth > 0);
  await page.waitForTimeout(800);
  return { ctx, page };
}
const shot = (page, n) => page.screenshot({ path: OUT + "web-" + n + ".png" });
const centre = async (page, sel) => { const b = await page.locator(sel).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const hintText = (page) => page.evaluate(() => { const h = document.getElementById("adultHint"); return h.hidden ? "" : h.textContent; });
const READY = { code: 200, text: "200 OK", paperOut: false, paperLow: false, coverOpen: false, error: false, online: true, lastSeenSec: 5 };

for (const [name, dev] of [["iphone", devices["iPhone 13"]], ["ipad", devices["iPad Pro 11"]]]) {
  const { ctx, page } = await booth(dev, {}, READY);
  // At rest: wordless, no badge (printer fine), no label.
  assert.equal(await hintText(page), "");
  assert.ok(await page.locator("#printerBadge").isHidden(), "no badge when the printer is fine");
  assert.ok(await page.locator("#shutter svg.ic").count(), "drawn shutter");
  const gear = await page.locator("#gearBtn").boundingBox();
  assert.ok(gear.width >= 43 && gear.width <= 70, `${name}: gear ${gear.width}px`);
  const shutter = await page.locator("#shutter").boundingBox();
  assert.ok(shutter.width >= 96, `${name}: shutter ${shutter.width}px`);
  await shot(page, `${name}-camera-rest-drawn`);

  // Short tap on the gear: a hint, no settings.
  await page.click("#gearBtn");
  await page.waitForTimeout(250);
  assert.equal(await hintText(page), "Hold to open settings");
  assert.equal(await page.locator("#settings.on").count(), 0, "tap doesn't open settings");
  await shot(page, `${name}-gear-tap-hint`);
  // It goes away by itself.
  await page.waitForTimeout(2800);
  assert.equal(await hintText(page), "");

  // Hold: "Keep holding…" with the ring filling, released early → nothing.
  const [gx, gy] = await centre(page, "#gearBtn");
  await page.mouse.move(gx, gy); await page.mouse.down(); await page.waitForTimeout(700);
  assert.equal(await hintText(page), "Keep holding…");
  assert.ok(await page.locator("#gearBtn.holding").count(), "ring shows while holding");
  await shot(page, `${name}-gear-holding`);
  await page.mouse.up(); await page.waitForTimeout(600);
  assert.equal(await page.locator("#settings.on").count(), 0, "released at 0.7 s: no settings");
  // Full hold → settings.
  await page.mouse.down(); await page.waitForTimeout(1400); await page.mouse.up();
  await page.locator("#settings.on").waitFor({ timeout: 3000 });
  log(`${name}: gear tap → hint, 0.7 s → nothing, 1.4 s → settings`);
  await page.waitForTimeout(500);
  await shot(page, `${name}-settings-top`);
  await page.evaluate(() => document.getElementById("settings").scrollTo(0, 1e5));
  await page.waitForTimeout(300);
  await shot(page, `${name}-settings-bottom`);
  if (name === "ipad") await page.screenshot({ path: OUT + "web-ipad-settings-full.png", fullPage: false });

  // Settings: Classic icon style, flash off, kid max 2, back camera default.
  await page.evaluate(() => document.getElementById("settings").scrollTo(0, 0));
  await page.click('#sIcons button[data-v="\\"classic\\""]');
  await page.click("#sFlash");
  await page.locator("#sKidMax button").first().click();   // 3 → 2
  const st = await page.evaluate(() => ({ icons: localStorage.getItem("booth.icons"), flash: localStorage.getItem("booth.flash"), max: localStorage.getItem("booth.copiesMax") }));
  assert.deepEqual(st, { icons: '"classic"', flash: "false", max: "2" });
  await page.click("#sDone");
  await page.locator("#cam.on").waitFor();
  await page.waitForTimeout(500);
  assert.ok(!(await page.locator("#shutter svg.ic").count()) && /📸/.test(await page.textContent("#shutter")), "Classic: emoji shutter");
  await shot(page, `${name}-camera-rest-classic`);
  // Kid max applies on review.
  await page.evaluate(() => localStorage.setItem("booth.shots", "1"));
  await page.click("#shutter");
  await page.locator("#review.on").waitFor({ timeout: 30000 });
  for (let i = 0; i < 5; i++) await page.click("#more");
  assert.equal(await page.textContent("#copyN"), "2", "kid max 2");
  await shot(page, `${name}-review-classic`);
  await page.evaluate(() => localStorage.setItem("booth.icons", '"drawn"'));
  await page.click("#retake");
  await page.locator("#cam.on").waitFor();
  await page.click("#shutter");
  await page.locator("#review.on").waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  await shot(page, `${name}-review-drawn`);
  log(`${name}: Classic / Drawn, flash + kid max settings stick`);
  await ctx.close();
}

// Printer badge: one drawing per problem; tap → its label (adults).
const PROBLEMS = {
  offline: [{ ...READY, online: false, lastSeenSec: 1500 }, /^Printer offline · last seen \d+:\d\d (am|pm) · Check its power & Wi-Fi$/, "pOffline"],
  paperOut: [{ ...READY, code: 410, paperOut: true }, /^Out of paper$/, "pPaperOut"],
  cover: [{ ...READY, code: 420, coverOpen: true }, /^Cover open$/, "pCover"],
  error: [{ ...READY, code: 520, error: true }, /^Printer error — turn it off and on$/, "pError"],
};
for (const [state, [h, label, icon]] of Object.entries(PROBLEMS)) {
  const { ctx, page } = await booth(devices["iPad Pro 11"], {}, h);
  await page.locator("#printerBadge:not([hidden])").waitFor({ timeout: 5000 });
  assert.equal(await page.locator("#printerBadge [data-ic]").getAttribute("data-ic"), icon);
  assert.equal(await hintText(page), "", "no label until tapped");
  await page.click("#printerBadge");
  await page.waitForTimeout(250);
  assert.match(await hintText(page), label);
  if (state === "offline") await shot(page, "ipad-printer-offline-label");
  if (state === "offline") { await page.mouse.click(5, 5); await page.waitForTimeout(300); assert.equal(await hintText(page), "", "another touch dismisses it"); await shot(page, "ipad-printer-offline-badge"); }
  await page.locator("#printerBadge").screenshot({ path: OUT + `web-badge-${state}.png` });
  log(`badge ${state}: ${icon}, label ${label}`);
  await ctx.close();
}

// Share the booth: tap → hint; hold → the sheet with the PIN.
{
  const { ctx, page } = await booth(devices["iPhone 13"], {}, READY);
  await page.click("#boothBtn");
  await page.waitForTimeout(250);
  assert.equal(await hintText(page), "Hold to share the booth");
  assert.ok(await page.locator("#share[hidden]").count(), "tap doesn't open the sheet");
  const [x, y] = await centre(page, "#boothBtn");
  await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(600);
  await shot(page, "iphone-booth-holding");
  await page.waitForTimeout(800); await page.mouse.up();
  await page.locator("#share:not([hidden])").waitFor({ timeout: 3000 });
  assert.equal(await page.textContent("#sharePin"), PIN);
  log("share the booth: tap → hint, hold → sheet");
  await ctx.close();
}
const errs = [];
await browser.close();
assert.equal(errs.length, 0);
console.log("redesign e2e: all passed; screenshots in", OUT);
