// End-to-end: party page → booth (fake camera) → strip with QR → print → album.
//
//   npm run dev:e2e          # terminal 1: wrangler dev (booth + cprnt DO, local R2/KV), PIN 1234
//   npm run test:e2e         # terminal 2 (BASE=http://localhost:8788 PIN=1234 by default)
//
// Uses Chromium's fake camera (a moving test pattern). Nothing reaches the
// real printer: local dev has no MQTT secrets and no printer polls it.
// Screenshots of every Thanksgiving strip land in e2e/out/.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://localhost:8788";
const PIN = process.env.PIN ?? "1234";
const OUT = new URL("./out/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const THANKS = ["turkey", "feast", "leaves", "starry", "harvest"];
const log = (...a) => console.log("•", ...a);

const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, permissions: ["camera"], acceptDownloads: true });
await ctx.addInitScript(([pin]) => {
  if (!localStorage.getItem("booth.pin")) localStorage.setItem("booth.pin", JSON.stringify(pin));
  localStorage.setItem("booth.sound", "false");
}, [PIN]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

// ---------- 1. party page: create + activate ----------
await page.goto(BASE + "/party.html");
await page.getByRole("button", { name: "➕ New party" }).click();
const name = `E2E Thanksgiving ${Date.now().toString(36)}`;
await page.fill("#edName", name);
await page.fill("#edDate", "2026-11-26");
await page.fill("#edFooter", "Thanksgiving 2026");
await page.click("#edSave");
await page.locator(".ev.active h2", { hasText: name }).waitFor();
log("party created + active");
const { events, active } = await page.evaluate(async (pin) => (await fetch("/api/events", { headers: { "x-booth-pin": pin } })).json(), PIN);
const ev = events.find((e) => e.slug === active);
assert.equal(ev.name, name);
assert.deepEqual(ev.themes, THANKS);
assert.equal(ev.theme, "turkey");

// Sign renders a QR (SVG) for the album.
await page.locator(".ev.active button[data-act=sign]").click();
await page.locator("#poster .qr svg").waitFor();
await page.screenshot({ path: new URL("sign.png", OUT).pathname, fullPage: true });
await page.click("#signBack");

// ---------- 2. booth: themes limited to the party, QR on the strip ----------
await page.goto(BASE + "/");
await page.locator("#cam.on").waitFor();
await page.waitForFunction((n) => document.querySelectorAll("#themes button").length === n, THANKS.length, { timeout: 10000 });
const offered = await page.$$eval("#themes button", (bs) => bs.map((b) => b.dataset.k));
assert.deepEqual(offered, THANKS, "booth offers only the party's frames");
await page.waitForFunction(() => document.getElementById("video").videoWidth > 0);
log("booth shows the 5 Thanksgiving frames");

let lastSid = null;
for (const theme of THANKS) {
  await page.click(`#themes button[data-k=${theme}]`);
  // single shot keeps the loop quick; the first theme uses a 3-photo strip
  const shots = theme === "turkey" ? 3 : 1;
  await page.evaluate((n) => localStorage.setItem("booth.shots", String(n)), shots);
  await page.click("#shutter");
  await page.locator("#review.on").waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
  const strip = await page.evaluate(async () => {
    const cv = document.getElementById("preview");
    let qr = null;
    if ("BarcodeDetector" in window) {
      const det = new BarcodeDetector({ formats: ["qr_code"] });
      qr = (await det.detect(cv))[0]?.rawValue ?? null;
    }
    return { w: cv.width, h: cv.height, png: cv.toDataURL(), qr };
  });
  writeFileSync(new URL(`strip-${theme}.png`, OUT), Buffer.from(strip.png.split(",")[1], "base64"));
  assert.equal(strip.w, 576);
  if (strip.qr !== null) {
    assert.match(strip.qr, new RegExp(`/a/${ev.share}/[0-9a-z]+-[0-9a-f]{8}$`), "strip QR → this guest's album page");
    lastSid = strip.qr.split("/").pop();
    log(`${theme}: ${strip.h}px strip, QR decodes → ${strip.qr}`);
  } else log(`${theme}: ${strip.h}px strip (BarcodeDetector unavailable — QR not decoded)`);
  if (theme !== THANKS.at(-1)) { await page.click("#retake"); await page.locator("#cam.on").waitFor(); }
}

// ---------- 3. print the last one ----------
const printReq = page.waitForResponse((r) => r.url().endsWith("/api/print") && r.request().method() === "POST");
await page.click("#printBtn");
const pr = await printReq;
assert.equal(pr.status(), 201, "print enqueued");
const job = await pr.json();
log("print enqueued", job.id);
// Archive upload (originals + strip) carries the event → session joins the album.
await page.waitForResponse((r) => r.url().endsWith("/api/archive") && r.status() === 201, { timeout: 30000 });

// ---------- 4. album ----------
const sid = lastSid ?? (await page.evaluate(() => null));
const album = await ctx.newPage();
await album.goto(`${BASE}/a/${ev.share}${sid ? "/" + sid : ""}`);
await album.locator("h1", { hasText: name }).waitFor();
await album.waitForFunction(() => document.querySelectorAll("#grid .card").length >= 1, null, { timeout: 30000 });
if (sid) {
  await album.locator("#mine h2", { hasText: "Your receipt" }).waitFor({ timeout: 30000 });
  await album.locator("#mineHero img.bits").waitFor({ timeout: 30000 });   // the printed strip, once its upload lands
  log("album deep link shows 'Your receipt' (the printed strip)");
}
const n = await album.locator("#grid .card").count();
log(`album lists ${n} session(s)`);
// open the viewer, check save link + image loads
await album.locator("#grid .tile").first().click();
await album.locator("#view.on").waitFor();
await album.waitForFunction(() => document.getElementById("viewImg").naturalWidth > 0);
const href = await album.getAttribute("#viewSave", "href");
assert.match(href, /dl=1/);
const dl = await album.request.get(BASE + href);
assert.equal(dl.status(), 200);
assert.match(dl.headers()["content-disposition"] ?? "", /attachment/);
await album.click("#viewClose");
// zip download
const [download] = await Promise.all([album.waitForEvent("download"), album.click("#zip")]);
assert.match(download.suggestedFilename(), /\.zip$/);
log("zip:", download.suggestedFilename());
await album.screenshot({ path: new URL("album.png", OUT).pathname, fullPage: true });

// Album without a valid token → friendly 404 state.
await album.goto(`${BASE}/a/abcdefghjkmn`);
await album.locator("h1", { hasText: "Album not found" }).waitFor();

// ---------- cleanup: deactivate so the next run starts clean ----------
await page.evaluate(async (pin) => fetch("/api/events/active", { method: "POST", headers: { "x-booth-pin": pin, "content-type": "application/json" }, body: JSON.stringify({ slug: null }) }), PIN);
const bad = errors.filter((e) => !/favicon|Failed to load resource|TensorFlow Lite/.test(e));
assert.deepEqual(bad, [], "no page errors");
await browser.close();
log("e2e OK — screenshots in e2e/out/");
