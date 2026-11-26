// Render the "use the booth on your own phone" sign (party.html → 📱 Booth sign) to a Letter PDF,
// without a running booth: headless Chromium loads public/party.html as if it were served from
// BOOTH_ORIGIN (requests are answered from this checkout; /api is stubbed), with the PIN put in
// the page's storage the way the party page's unlock does. The PIN is read from the environment
// and never printed.
//
//   BOOTH_PIN=… node scripts/web-sign.mjs out.pdf [preview.png]
//   (optional: BOOTH_ORIGIN=https://booth.receiptd.sh, the host the QR points at)
//
// The QR carries <BOOTH_ORIGIN>/#pin=<PIN>, which opens the web booth already unlocked.
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const [out, png] = process.argv.slice(2);
const PIN = process.env.BOOTH_PIN ?? "";
const ORIGIN = new URL(process.env.BOOTH_ORIGIN ?? "https://booth.receiptd.sh").origin;
if (!out || !PIN.trim()) {
  console.error("usage: BOOTH_PIN=… node scripts/web-sign.mjs out.pdf [preview.png]");
  process.exit(2);
}
const PUBLIC = new URL("../public/", import.meta.url);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
                ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(ORIGIN + "/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(path === "/api/events" ? { events: [], active: null } : {}) });
    }
    try {
      const file = new URL("." + decodeURIComponent(path), PUBLIC);
      if (!file.href.startsWith(PUBLIC.href)) throw new Error("outside public/");
      await route.fulfill({ status: 200, contentType: TYPES[extname(file.pathname)] ?? "application/octet-stream", body: await readFile(file) });
    } catch { await route.fulfill({ status: 404, body: "not found" }); }
  });
  // Same storage the party page's unlock writes (localStorage "booth.pin", JSON).
  await page.addInitScript((pin) => localStorage.setItem("booth.pin", JSON.stringify(pin)), PIN.trim());
  await page.goto(ORIGIN + "/party.html#sign=web");
  await page.locator("#poster .sg-web .sg-qrcard svg").waitFor({ timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);   // fitSignTitles runs after the font loads
  if (errors.length) throw new Error("page errors: " + errors.join("; "));
  await page.pdf({ path: resolve(out), preferCSSPageSize: true, printBackground: true });
  if (png) {
    await page.emulateMedia({ media: "print" });
    await page.setViewportSize({ width: 816, height: 1056 });
    await page.locator("#poster .sg-page").screenshot({ path: resolve(png), scale: "device" });
  }
  console.log(`wrote ${resolve(out)}${png ? " and " + resolve(png) : ""} (QR → ${ORIGIN}/#pin=<BOOTH_PIN>)`);
} finally {
  await browser.close();
}
