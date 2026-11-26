// Sharing, end to end against the local booth (npm run dev:e2e, PIN 1234; nothing reaches the
// real printer): shoot → "share this photo" (QR on review) → print → open /s/<token> → strip +
// originals shown; an expired link → 404; "share the booth" sheet shows the PIN; the stage is
// the slot's shape in portrait / landscape iPad and an iPhone. Screenshots → e2e/out/share/.
//   BASE=http://localhost:8788 PIN=1234 node e2e/share.e2e.mjs
import { chromium, devices } from "playwright";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";

const BASE = process.env.BASE ?? "http://localhost:8788";
const PIN = process.env.PIN ?? "1234";
const OUT = new URL("./out/share/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("•", ...a);
const hdr = { "x-booth-pin": PIN, "content-type": "application/json" };
await fetch(BASE + "/api/events/active", { method: "POST", headers: hdr, body: JSON.stringify({ slug: null }) });   // no party: links work without one

const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
async function booth(opts) {
  const ctx = await browser.newContext({ permissions: ["camera"], ...opts });
  await ctx.addInitScript(([pin]) => {
    if (sessionStorage.getItem("seeded")) return;
    sessionStorage.setItem("seeded", "1");
    localStorage.setItem("booth.pin", JSON.stringify(pin));
    localStorage.setItem("booth.count", "1");
    localStorage.setItem("booth.sound", "false");
    localStorage.setItem("booth.shots", "3");
  }, [PIN]);
  const page = await ctx.newPage();
  page.errs = [];
  page.on("pageerror", (e) => page.errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") page.errs.push(m.text()); });
  await page.goto(BASE + "/");
  await page.locator("#cam.on").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.getElementById("video").videoWidth > 0);
  return { ctx, page };
}
const shot = (page, n) => page.screenshot({ path: OUT + n + ".png" });

// ---------- 1. stage = slot shape (no bars) on iPad portrait / landscape + iPhone ----------
for (const [name, dev] of [["ipad-portrait", devices["iPad Pro 11"]], ["ipad-landscape", devices["iPad Pro 11 landscape"]], ["iphone", devices["iPhone 13"]]]) {
  const { ctx, page } = await booth(dev);
  await page.waitForFunction(() => document.getElementById("live").classList.contains("on"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => {
    const st = document.getElementById("stage"), v = document.getElementById("video"), cs = getComputedStyle(st);
    const r = st.getBoundingClientRect(), bw = parseFloat(cs.borderLeftWidth);
    const inner = { w: r.width - 2 * bw, h: r.height - 2 * bw };
    const b = document.getElementById("boothBtn").getBoundingClientRect(), hs = document.getElementById("gearBtn").getBoundingClientRect();
    const th = document.getElementById("themes").getBoundingClientRect(), tray = document.getElementById("tray").getBoundingClientRect();
    const badge = document.getElementById("printerBadge").getBoundingClientRect();
    const hit = (a, c) => c.width > 0 && a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom;
    return { inner, frame: v.videoWidth / v.videoHeight, live: document.getElementById("live").classList.contains("on"),
      inView: r.right <= innerWidth && r.bottom <= innerHeight && r.left >= 0 && r.top >= 0,
      boothHitsGear: hit(b, hs), boothHitsThemes: hit(b, th), boothHitsTray: hit(b, tray), boothHitsBadge: hit(b, badge), boothHitsStage: hit(b, r),
      boothInView: b.width > 0 && b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight, boothSize: b.width };
  });
  const want = m.frame >= 1 ? 4 / 3 : 4 / 5, got = m.inner.w / m.inner.h;
  assert.ok(Math.abs(got - want) < 0.01, `${name}: stage ${m.inner.w.toFixed(1)}×${m.inner.h.toFixed(1)} = ${got.toFixed(3)}, slot ${want.toFixed(3)}`);
  assert.ok(m.inView, `${name}: stage fits on screen`);
  // Share the booth: off the camera window, at the end of the theme bar, clear of the themes, gear, tray and printer badge.
  assert.ok(m.boothInView && !m.boothHitsStage && !m.boothHitsGear && !m.boothHitsThemes && !m.boothHitsTray && !m.boothHitsBadge,
    `${name}: share-the-booth beside the themes, off the stage ${JSON.stringify(m)}`);
  log(`${name}: stage ${m.inner.w.toFixed(0)}×${m.inner.h.toFixed(0)} (slot ${want.toFixed(3)}), live dots ${m.live ? "on" : "off"}`);
  await shot(page, `stage-${name}`);
  if (name === "ipad-portrait") {   // the plain camera (live preview off) has the same shape
    await page.evaluate(() => localStorage.setItem("booth.live", "false"));
    await page.waitForTimeout(400);
    await shot(page, `stage-${name}-live-off`);
  }
  await ctx.close();
}

// ---------- 2. share the booth: sheet shows the PIN ----------
{
  const { ctx, page } = await booth(devices["iPad Pro 11"]);
  // Press and hold (a tap only shows "Hold to share the booth").
  await page.click("#boothBtn");
  assert.equal(await page.textContent("#adultHint"), "Hold to share the booth");
  assert.ok(await page.locator("#share[hidden]").count(), "a tap doesn't open the sheet");
  const bb = await page.locator("#boothBtn").boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.waitForTimeout(1500); await page.mouse.up();
  await page.locator("#share:not([hidden])").waitFor();
  assert.equal(await page.textContent("#share h2"), "Share the booth");
  assert.match(await page.textContent("#share .lead"), /use their own phone as a booth too/);
  assert.match(await page.textContent("#share .grants"), /This lets them use your booth \(prints, photos\)/);
  assert.equal(await page.textContent("#sharePin"), PIN);
  assert.ok(await page.locator("#qrWeb svg").count() && await page.locator("#qrApp svg").count());
  await shot(page, "share-the-booth");
  await page.click("#shareClose");
  log("share the booth: PIN + both QR codes");
  await ctx.close();
}

// ---------- 3. share this photo: review → QR → print → /s/<token> ----------
const { ctx, page } = await booth({ ...devices["iPad Pro 11"], acceptDownloads: true });
await page.click("#shutter");
await page.locator("#review.on").waitFor({ timeout: 30000 });
const shareRes = page.waitForResponse((r) => /\/api\/sessions\/[^/]+\/share$/.test(r.url()));
await page.click("#mineReview");
assert.equal((await shareRes).status(), 201);
await page.locator("#mineQR svg").waitFor({ timeout: 10000 });
const url = await page.getAttribute("#mineQR", "data-url");
assert.match(url, new RegExp(`^${BASE}/s/[a-hjkmnp-z2-9]{12}$`));
const qr = await page.evaluate(async () => {
  if (!("BarcodeDetector" in window)) return null;
  const svg = document.querySelector("#mineQR svg"), img = new Image();
  img.src = "data:image/svg+xml;base64," + btoa(new XMLSerializer().serializeToString(svg));
  await img.decode();
  const c = new OffscreenCanvas(600, 600), g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 600, 600); g.drawImage(img, 0, 0, 600, 600);
  return (await new BarcodeDetector({ formats: ["qr_code"] }).detect(await createImageBitmap(c)))[0]?.rawValue ?? null;
});
if (qr !== null) assert.equal(qr, url, "on-screen QR decodes to the link");
log("review: your-photos QR →", url, qr ? "(decoded)" : "(BarcodeDetector unavailable)");
await shot(page, "review-your-photos");
// The share sheet gets the files themselves (strip + 3 originals).
const files = await page.evaluate(async () => {
  let got = null;
  navigator.canShare = () => true;
  navigator.share = async (d) => { got = d.files.map((f) => `${f.name}:${f.type}:${f.size > 0}`); };
  document.getElementById("mineFiles").click();
  for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 100));
  return got;
});
assert.equal(files?.length, 4, JSON.stringify(files));
assert.match(files[0], /-strip\.png:image\/png:true$/);
assert.ok(files.slice(1).every((f) => /-\d\.jpg:image\/jpeg:true$/.test(f)), JSON.stringify(files));
log("📲 share sheet gets", files.length, "files");
await page.click("#mineClose");
assert.ok(await page.locator("#mine").isHidden());

// Print, then open the link on "another phone".
await page.click("#printBtn");
await page.locator("#printing.on").waitFor();
await page.click("#minePrinting");
await page.locator("#mineQR svg").waitFor();
assert.equal(await page.getAttribute("#mineQR", "data-url"), url, "same link again (cached per session)");
await shot(page, "printing-your-photos");
for (let i = 0; i < 60; i++) {   // the background upload: originals first, strip.png once the print is enqueued
  const f = (await (await fetch(url.replace("/s/", "/api/s/"))).json()).session.files;
  if (f["strip.png"] && Object.keys(f).length === 4) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const guest = await browser.newContext(devices["iPhone 13"]);
const g = await guest.newPage();
await g.goto(url);
await g.locator("#receipt:not(.pending) #stripImg").waitFor({ timeout: 30000 });
await g.waitForFunction(() => [...document.querySelectorAll("main img")].every((i) => i.complete && i.naturalWidth > 0) && document.querySelectorAll("#thumbs img").length === 3, null, { timeout: 30000 });
// The receipt is the hero: the first (and biggest) image on the page is the printed strip, drawn dot for dot.
const hero = await g.evaluate(() => {
  const imgs = [...document.querySelectorAll("main img")], first = imgs[0], area = (i) => i.getBoundingClientRect().width * i.getBoundingClientRect().height;
  return { firstSrc: first.getAttribute("src"), biggest: imgs.every((i) => area(i) <= area(first)), rendering: getComputedStyle(first).imageRendering, nat: first.naturalWidth };
});
assert.match(hero.firstSrc, /strip\.png/, "first image is the receipt");
assert.ok(hero.biggest, "the receipt is the biggest image");
assert.equal(hero.rendering, "pixelated");
assert.equal(hero.nat, 576, "the 576-dot printed bitmap");
assert.ok(await g.locator("#saveStrip").isVisible() && await g.locator("#savePhotos").isVisible(), "save receipt / save photos");
await g.screenshot({ path: OUT + "guest-page.png", fullPage: true });
mkdirSync(new URL("./out/receipt-hero/", import.meta.url).pathname, { recursive: true });
await g.screenshot({ path: new URL("./out/receipt-hero/s-token-iphone-booth-print.png", import.meta.url).pathname, fullPage: true });
log("guest page: receipt hero + 3 colour originals");

// Expired link → 404 (page and API).
const sid = (await (await fetch(url.replace("/s/", "/api/s/"))).json()).session.id;
const short = await (await fetch(`${BASE}/api/sessions/${sid}/share`, { method: "POST", headers: hdr, body: JSON.stringify({ ttl: 1 }) })).json();
short.url = `${BASE}/s/${short.token}`;
await new Promise((r) => setTimeout(r, 1500));
assert.equal((await fetch(short.url.replace("/s/", "/api/s/"))).status, 404);
await g.goto(short.url);
await g.locator("h1", { hasText: "Link expired" }).waitFor();
await g.screenshot({ path: OUT + "guest-expired.png" });
log("expired link → 404 / 'Link expired'");

const bad = page.errs.filter((e) => !/favicon|Failed to load resource|TensorFlow Lite/.test(e));
assert.deepEqual(bad, [], "no page errors");
await browser.close();
log("share e2e OK — screenshots in e2e/out/share/");
