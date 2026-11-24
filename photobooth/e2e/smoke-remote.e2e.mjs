// Remote smoke test (no PIN needed). BASE=https://booth-staging.receiptd.sh node e2e/smoke-remote.e2e.mjs
import { chromium, webkit, devices } from "playwright";
import { mkdirSync } from "node:fs";
const BASE = (process.env.BASE ?? "https://booth-staging.receiptd.sh").replace(/\/$/, "");
const OUT = new URL("./out/remote/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = async (name, fn) => { try { await fn(); console.log("PASS", name); } catch (e) { fails.push(name); console.log("FAIL", name, "::", e.message.split("\n")[0]); } };
const ok = (v, m) => { if (!v) throw new Error(m); };
const THEMES = ["turkey", "feast", "leaves", "starry", "harvest"];
const QR = BASE + "/a/abcdefghjkmn/mhz3k2a1-0f3a9c11";
const targets = [
  ["chromium-ipad", chromium, devices["iPad Mini"]],
  ["chromium-iphone", chromium, devices["iPhone 15"]],
  ["webkit-ipad", webkit, devices["iPad Mini"]],
  ["webkit-iphone", webkit, devices["iPhone 15"]],
];

await check("API: version/events/album", async () => {
  const g = (p) => fetch(BASE + p);
  const v = await (await g("/api/version")).json(); ok(v.id || v.version, "no id: " + JSON.stringify(v));
  for (const p of ["/api/events", "/api/events/active"]) ok((await g(p)).status === 401, p + " not 401");
  ok((await g("/api/album/abcdefghjkmn")).status === 404, "album not 404");
  ok((await g("/api/album/abcdefghjkmn/file?key=x")).status === 404, "file not 404");
});

for (const [label, bt, dev] of targets) {
  const browser = await bt.launch();
  const ctx = await browser.newContext({ ...dev });
  const page = await ctx.newPage();
  const errs = [], bad = [], seen = new Map();
  page.on("pageerror", (e) => errs.push("pageerror " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console " + m.text()); });
  page.on("response", (r) => { seen.set(new URL(r.url()).pathname, r.status()); if (r.status() >= 400) bad.push(r.status() + " " + r.url()); });
  const P = (n) => `[${label}] ${n}`;

  await check(P("/ lock screen, assets 200, no errors"), async () => {
    await page.goto(BASE + "/", { waitUntil: "load" });
    await page.locator("#pin").waitFor({ state: "visible", timeout: 8000 });
    await page.evaluate(async () => { await import("/frames.js"); await import("/qr.js"); await import("/vendor/qrcode/qrcode.mjs"); await fetch("/album"); });
    await page.waitForTimeout(500);
    for (const p of ["/frames.js", "/qr.js", "/vendor/qrcode/qrcode.mjs", "/album"]) ok(seen.get(p) === 200, p + " status " + seen.get(p));
    ok([...seen].some(([p, s]) => /\.woff2?$/.test(p) && s === 200), "no font 200");
    ok(!errs.length && !bad.length, JSON.stringify({ errs, bad }));
  });
  for (const p of ["/party.html", "/gallery.html"]) await check(P(p + " PIN form"), async () => {
    await page.goto(BASE + p, { waitUntil: "load" });
    await page.locator("#pin").waitFor({ state: "visible", timeout: 8000 });
  });
  for (const p of ["/a/abcdefghjkmn", "/a/abcdefghjkmn/mhz3k2a1-0f3a9c11"]) await check(P(p + " Album not found"), async () => {
    await page.goto(BASE + p, { waitUntil: "load" });
    await page.getByText("Album not found").first().waitFor({ timeout: 8000 });
  });

  await check(P("compose 5 themes + QR"), async () => {
    await page.goto(BASE + "/", { waitUntil: "load" });
    for (const th of THEMES) {
      const r = await page.evaluate(async ([th, qr]) => {
        const { compose } = await import("/frames.js");
        const f = new OffscreenCanvas(640, 480), x = f.getContext("2d");
        x.fillStyle = "#888"; x.fillRect(0, 0, 640, 480); x.fillStyle = "#fff"; x.fillRect(200, 100, 200, 200);
        const { canvas } = compose([f, f, f], { theme: th, seed: 7, footer: "smoke", qr });
        const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
        c.getContext("2d").drawImage(canvas, 0, 0);
        let decoded = null;
        if (window.BarcodeDetector) {
          try {
            const q = await new BarcodeDetector({ formats: ["qr_code"] }).detect(c);
            decoded = q[0]?.rawValue ?? "";
          } catch (e) { decoded = "ERR " + e.message; }
        }
        return { url: c.toDataURL("image/png"), decoded, w: c.width, h: c.height };
      }, [th, QR]);
      const fs = await import("node:fs");
      fs.writeFileSync(`${OUT}${label}-${th}.png`, Buffer.from(r.url.split(",")[1], "base64"));
      ok(r.h > 500, th + " tiny strip");
      if (bt === chromium && r.decoded !== null) { console.log(`   QR ${th}: ${JSON.stringify(r.decoded)}`); ok(r.decoded === QR, th + " QR mismatch: " + r.decoded); }
    }
  });
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} FAILED` : "\nALL PASSED");
process.exit(fails.length ? 1 : 0);
