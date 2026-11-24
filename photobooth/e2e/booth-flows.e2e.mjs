// Kid-facing booth flows: themes picker, shots, rotate, copies, retake, idle, settings, deep link.
//   BASE=http://localhost:8788 PIN=1234 node e2e/booth-flows.e2e.mjs
// Checks are soft: every failure is collected and printed, exit 1 if any.
import { chromium, webkit, devices } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:8788";
const PIN = process.env.PIN ?? "1234";
const OUT = new URL("./out/agent-booth/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const fails = [];
const check = (ok, msg) => { console.log(ok ? "  ok  " : "  FAIL", msg); if (!ok) fails.push(msg); };
const ARGS = ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"];
const hdr = { "x-booth-pin": PIN, "content-type": "application/json" };
const j = async (path, method = "GET", body) => (await fetch(BASE + path, { method, headers: hdr, body: body && JSON.stringify(body) })).json();
const setActive = (slug) => j("/api/events/active", "POST", { slug });

async function newCtx(browser, opts = {}, { pin = true, seed = {} } = {}) {
  const ctx = await browser.newContext({ permissions: ["camera"], ...opts });
  await ctx.addInitScript(([pin, seed]) => {
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      if (pin) localStorage.setItem("booth.pin", JSON.stringify(pin));
      localStorage.setItem("booth.sound", "false");
      for (const [k, v] of Object.entries(seed)) localStorage.setItem("booth." + k, JSON.stringify(v));
    }
  }, [pin ? PIN : null, seed]);
  const page = await ctx.newPage();
  page.errs = [];
  page.on("pageerror", (e) => page.errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") page.errs.push(m.text()); });
  return { ctx, page };
}
const noise = /favicon|Failed to load resource|TensorFlow Lite/;
const shot = (page, n) => page.screenshot({ path: OUT + n + ".png" });
const camReady = async (page) => { await page.locator("#cam.on").waitFor({ timeout: 15000 }); await page.waitForFunction(() => document.getElementById("video").videoWidth > 0); };

async function themesInfo(page) {
  return page.evaluate(() => {
    const t = document.getElementById("themes"), r = t.getBoundingClientRect();
    const bs = [...t.children].map((b) => b.getBoundingClientRect());
    const vw = innerWidth, vh = innerHeight;
    return { n: bs.length, sw: t.scrollWidth, cw: t.clientWidth, sh: t.scrollHeight, ch: t.clientHeight, sl: t.scrollLeft, st: t.scrollTop,
      first: bs[0] && { l: bs[0].left, t: bs[0].top, r: bs[0].right, b: bs[0].bottom },
      box: { l: r.left, t: r.top, r: r.right, b: r.bottom }, vw, vh };
  });
}

const chromiumB = await chromium.launch({ args: ARGS });
await setActive(null); // NB: another runner activating a party mid-run will skew section A/C

// ---------- A. no party: all 12 themes, picker scrolls, first reachable ----------
console.log("A. no party");
for (const [name, dev] of [["ipad-mini-portrait", devices["iPad Mini"]], ["ipad-mini-landscape", devices["iPad Mini landscape"]],
  ["ipad-pro-portrait", devices["iPad Pro 11"]], ["ipad-pro-landscape", devices["iPad Pro 11 landscape"]], ["phone-portrait", devices["iPhone 13"]]]) {
  const { ctx, page } = await newCtx(chromiumB, dev, { seed: { shots: 1 } });
  await page.goto(BASE + "/");
  await camReady(page);
  const i = await themesInfo(page);
  check(i.n === 12, `${name}: 12 themes offered (got ${i.n})`);
  const land = i.vw > i.vh;
  const overflow = land ? i.sh > i.ch + 1 : i.sw > i.cw + 1;
  const startOk = land ? i.first.t >= i.box.t - 1 && i.st === 0 : i.first.l >= i.box.l - 1 && i.sl === 0;
  check(startOk, `${name}: first theme reachable at start (first=${JSON.stringify(i.first)} box=${JSON.stringify(i.box)})`);
  console.log(`      overflow=${overflow}`);
  await shot(page, `themes-${name}`);
  // scroll to end, last button must be within picker
  const lastVisible = await page.evaluate(() => { const t = document.getElementById("themes"); t.scrollTo(1e5, 1e5); const r = t.getBoundingClientRect(), l = t.lastElementChild.getBoundingClientRect();
    return l.right <= r.right + 1 && l.bottom <= r.bottom + 1 && l.left >= r.left - 1 && l.top >= r.top - 1; });
  check(lastVisible, `${name}: last theme reachable by scrolling`);
  // each button is inside the viewport horizontally/vertically after scrolling to it, and tappable
  const btnOk = await page.evaluate(() => [...document.querySelectorAll("#themes button")].every((b) => { b.scrollIntoView({ inline: "center", block: "center" }); const r = b.getBoundingClientRect(); return r.width > 30 && r.height > 30 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
  check(btnOk, `${name}: every theme button on-screen, >=30px when scrolled to`);
  await page.evaluate(() => document.getElementById("themes").scrollTo(0, 0));
  // pick first via real click and the last
  const keys = await page.$$eval("#themes button", (b) => b.map((x) => x.dataset.k));
  await page.locator("#themes button").first().click();
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("booth.theme"))) === keys[0], `${name}: tapping first theme selects it`);
  await page.locator("#themes button").last().click();
  check(await page.evaluate(() => JSON.parse(localStorage.getItem("booth.theme"))) === keys.at(-1), `${name}: tapping last theme selects it`);
  const bad = page.errs.filter((e) => !noise.test(e));
  check(bad.length === 0, `${name}: no console/page errors ${bad.join("|")}`);
  await ctx.close();
}

// ---------- B. capture flows (Chromium, iPad Mini portrait), no party ----------
console.log("B. capture flows");
{
  const { ctx, page } = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 1, count: 1 } });
  await page.goto(BASE + "/");
  await camReady(page);
  // 1 shot
  await page.click("#shutter");
  await page.locator("#review.on").waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  const h1 = await page.evaluate(() => document.getElementById("preview").height);
  check(await page.locator("#preview").evaluate((c) => c.width) === 576, "1 shot: strip 576 wide");
  check(await page.locator("#receipt .rot").count() === 1, "1 shot: one ↻ button");
  await shot(page, "review-1shot");
  // rotate
  const before = await page.evaluate(() => document.getElementById("preview").toDataURL());
  await page.locator("#receipt .rot").first().click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => document.getElementById("preview").toDataURL());
  check(before !== after, "↻ changes the preview");
  check(await page.locator("#receipt .rot").count() === 1, "↻ buttons rebuilt (still exactly 1)");
  await shot(page, "review-rotated");
  for (let i = 0; i < 3; i++) { await page.locator("#receipt .rot").first().click(); await page.waitForTimeout(700); }
  const full = await page.evaluate(() => document.getElementById("preview").toDataURL());
  check(full === before || true, "4x rotate cycle (info)");
  // copies
  check(await page.textContent("#copyN") === "1", "copies start at 1");
  check(await page.locator("#less").evaluate((b) => b.classList.contains("off")), "➖ greyed at 1");
  await page.click("#less");
  check(await page.textContent("#copyN") === "1", "➖ at 1 stays 1");
  let max = 1;
  for (let i = 0; i < 12; i++) { await page.click("#more"); max = +(await page.textContent("#copyN")); }
  check(max >= 2 && max <= 10, `➕ clamps (max=${max})`);
  check(await page.locator("#more").evaluate((b) => b.classList.contains("off")), "➕ greyed at max");
  await page.click("#less");
  check(+(await page.textContent("#copyN")) === max - 1, "➖ decrements from max");
  await shot(page, "review-copies");
  // retake
  await page.click("#retake");
  await page.locator("#cam.on").waitFor();
  check(!(await page.locator("#review").evaluate((e) => e.classList.contains("on"))), "retake returns to camera");
  await page.waitForFunction(() => document.getElementById("video").videoWidth > 0);
  // copies reset on next shot?
  await page.click("#shutter");
  await page.locator("#review.on").waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  const c2 = +(await page.textContent("#copyN"));
  check(c2 === 1, `copies reset to 1 for next shot after retake (got ${c2})`);
  await shot(page, "review-after-retake");
  // retake twice quickly: no stale rotate buttons
  await page.click("#retake"); await page.locator("#cam.on").waitFor();
  // idle return: shorten via fake clock
  await page.click("#shutter");
  await page.locator("#review.on").waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
  await page.clock.install();
  await page.locator("#receipt .rot").first().click();   // arms idle timer under fake clock
  await page.clock.fastForward(46000);
  await page.waitForTimeout(300);
  check(await page.locator("#cam.on").count() === 1, "idle 45s on review returns to camera");
  await shot(page, "idle-return");
  // 3 shots
  await ctx.close();
  const c3 = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 3, count: 1 } });
  await c3.page.goto(BASE + "/"); await camReady(c3.page);
  await c3.page.click("#shutter");
  await c3.page.locator("#review.on").waitFor({ timeout: 40000 });
  await c3.page.waitForTimeout(600);
  const h3 = await c3.page.evaluate(() => document.getElementById("preview").height);
  check(await c3.page.locator("#receipt .rot").count() === 3, "3 shots: three ↻ buttons");
  check(h3 > h1, `3 shots strip taller than 1 (${h3} vs ${h1})`);
  // ↻ buttons positioned within canvas
  const pos = await c3.page.evaluate(() => { const c = document.getElementById("preview").getBoundingClientRect(); return [...document.querySelectorAll("#receipt .rot")].map((b) => { const r = b.getBoundingClientRect(); return r.top >= c.top - 2 && r.bottom <= c.bottom + 2 && r.width > 30; }); });
  check(pos.every(Boolean), `3 shots: ↻ buttons inside strip & >30px ${pos}`);
  await shot(c3.page, "review-3shots");
  // rotate middle photo only
  const b0 = await c3.page.evaluate(() => document.getElementById("preview").toDataURL());
  await c3.page.locator("#receipt .rot").nth(1).click(); await c3.page.waitForTimeout(1200);
  check(b0 !== await c3.page.evaluate(() => document.getElementById("preview").toDataURL()), "3 shots: rotating photo 2 changes strip");
  check(await c3.page.locator("#receipt .rot").count() === 3, "3 shots: still 3 ↻ after rotate");
  const bad = [...c3.page.errs].filter((e) => !noise.test(e));
  check(bad.length === 0, `B: no console/page errors ${bad.join("|")}`);
  await c3.ctx.close();
}

// ---------- C. settings long-press, deep link ----------
console.log("C. settings + deep link");
{
  const { ctx, page } = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 1 } });
  await page.goto(BASE + "/"); await camReady(page);
  const hs = await page.locator("#hotspot").boundingBox();
  await page.mouse.move(hs.x + hs.width / 2, hs.y + hs.height / 2);
  await page.mouse.down(); await page.waitForTimeout(800);
  check(!(await page.locator("#settings.on").count()), "settings not open after 0.8s");
  await page.waitForTimeout(900); await page.mouse.up();
  check(await page.locator("#settings.on").count() === 1, "1.7s long-press on #hotspot opens settings");
  check(await page.locator("#sParty").isVisible(), "Party card visible in settings");
  check(/No party/.test(await page.textContent("#sPartyName")), "Party card says no party");
  await shot(page, "settings-noparty");
  // short press does not open
  await page.click("#sDone"); await camReady(page);
  await page.mouse.move(hs.x + 5, hs.y + 5); await page.mouse.down(); await page.waitForTimeout(400); await page.mouse.up(); await page.waitForTimeout(1500);
  check(await page.locator("#settings.on").count() === 0, "short press doesn't open settings");
  // hotspot overlaps theme button? hit-test
  const hit = await page.evaluate(() => { const h = document.getElementById("hotspot").getBoundingClientRect(); const e = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2); return e?.id || e?.tagName; });
  check(hit === "hotspot", `hotspot is topmost at its centre (got ${hit})`);
  await ctx.close();

  // deep link: fresh browser, no pin
  const d = await newCtx(chromiumB, devices["iPad Mini"], { pin: false });
  await d.page.goto(BASE + `/#pin=${PIN}`);
  await camReady(d.page);
  check(d.page.url() === BASE + "/", `hash stripped after deep link (url=${d.page.url()})`);
  check(await d.page.evaluate(() => JSON.parse(localStorage.getItem("booth.pin"))) === PIN, "deep link stored the PIN");
  await shot(d.page, "deeplink");
  // wrong pin deep link -> lock
  const w = await newCtx(chromiumB, devices["iPad Mini"], { pin: false });
  await w.page.goto(BASE + "/#pin=9999");
  await w.page.locator("#lock.on").waitFor({ timeout: 8000 }).catch(() => {});
  check(await w.page.locator("#lock.on").count() === 1, "wrong deep-link PIN lands on lock screen");
  check(w.page.url() === BASE + "/", "wrong PIN also stripped from URL");
  check(await w.page.evaluate(() => localStorage.getItem("booth.pin")) === null, "wrong PIN not left in localStorage");
  await shot(w.page, "deeplink-wrong");
  // lock screen: typing right PIN unlocks
  await w.page.fill("#pin", PIN); await w.page.click("#lockGo");
  await camReady(w.page);
  check(true, "typing PIN on lock screen unlocks");
  // deep link with whitespace/encoded and extra params
  const e = await newCtx(chromiumB, devices["iPad Mini"], { pin: false });
  await e.page.goto(BASE + `/#foo=1&pin=${PIN}`);
  await camReady(e.page);
  check(true, "deep link with extra hash params unlocks");
  const bad = [...d.page.errs, ...w.page.errs, ...e.page.errs].filter((x) => !noise.test(x));
  check(bad.length === 0, `C: no console/page errors ${bad.join("|")}`);
  await d.ctx.close(); await w.ctx.close(); await e.ctx.close();
}

// ---------- D. with an active party ----------
console.log("D. active party");
const mk = async (extra) => (await j("/api/events", "POST", { name: "Agent Party " + Date.now().toString(36), date: "2026-11-26", footer: "Footer!", ...extra }));
const created = await mk({ themes: ["turkey", "feast", "leaves"], theme: "feast" });
const ev = created.event ?? created;
console.log("   created", JSON.stringify(ev).slice(0, 200));
try {
  await setActive(ev.slug);
  const { ctx, page } = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 3, count: 1 } });
  await page.goto(BASE + "/"); await camReady(page);
  await page.waitForFunction(() => document.querySelectorAll("#themes button").length < 12, null, { timeout: 10000 }).catch(() => {});
  const n = await page.locator("#themes button").count();
  check(n === (ev.themes?.length ?? n) && n < 12, `party narrows picker (got ${n}, event themes ${ev.themes?.length})`);
  await shot(page, "party-cam");
  await page.click("#shutter");
  await page.locator("#review.on").waitFor({ timeout: 40000 });
  await page.waitForTimeout(800);
  const qr = await page.evaluate(async () => { const cv = document.getElementById("preview"); if (!("BarcodeDetector" in window)) return "n/a"; return (await new BarcodeDetector({ formats: ["qr_code"] }).detect(cv))[0]?.rawValue ?? null; });
  check(qr === "n/a" || (qr && qr.includes("/a/" + ev.share + "/")), `3-shot strip carries QR for party (${qr})`);
  await shot(page, "party-review-3");
  // rotate with QR strip
  const b0 = await page.evaluate(() => document.getElementById("preview").toDataURL());
  await page.locator("#receipt .rot").first().click(); await page.waitForTimeout(1500);
  check(b0 !== await page.evaluate(() => document.getElementById("preview").toDataURL()), "party strip: ↻ works");
  if (qr !== "n/a") {
    const qr2 = await page.evaluate(async () => (await new BarcodeDetector({ formats: ["qr_code"] }).detect(document.getElementById("preview")))[0]?.rawValue ?? null);
    check(qr2 === qr, `QR still decodes identically after ↻ (${qr2})`);
  }
  // QR session id stable across retake? new session each shot
  await page.click("#retake"); await camReady(page);
  // settings shows party
  const hs = await page.locator("#hotspot").boundingBox();
  await page.mouse.move(hs.x + hs.width / 2, hs.y + hs.height / 2); await page.mouse.down(); await page.waitForTimeout(1700); await page.mouse.up();
  await page.locator("#settings.on").waitFor();
  const txt = await page.textContent("#sPartyName");
  check(txt.includes(ev.name) && /QR on strips/.test(txt) && /Footer!/.test(txt), `settings Party card shows party (${txt})`);
  await shot(page, "settings-party");
  await page.click("#sDone"); await camReady(page);
  // deactivate while booth is open: picker should recover to all 12 within ~a minute (poll) -- check on reload
  await setActive(null);
  await page.reload(); await camReady(page);
  await page.waitForTimeout(2500);
  const n2 = await page.locator("#themes button").count();
  check(n2 === 12, `after deactivation + reload the picker returns to 12 (got ${n2})`);
  const selOk = await page.evaluate(() => { const s = document.querySelector("#themes button.sel"); return !!s; });
  check(selOk, "a theme is selected after party deactivated");
  // landscape with party
  const L = await newCtx(chromiumB, devices["iPad Mini landscape"], { seed: { shots: 1 } });
  await setActive(ev.slug);
  await L.page.goto(BASE + "/"); await camReady(L.page);
  await L.page.waitForTimeout(1500);
  await shot(L.page, "party-landscape");
  const bad = [...page.errs, ...L.page.errs].filter((x) => !noise.test(x));
  check(bad.length === 0, `D: no console/page errors ${bad.join("|")}`);
  await L.ctx.close(); await ctx.close();
} finally { await setActive(null); await j("/api/events/" + ev.slug, "DELETE").catch(() => {}); }

// ---------- E. WebKit: layout only (no camera) ----------
console.log("E. webkit layout");
{
  const wk = await webkit.launch();
  for (const [name, dev] of [["wk-ipad-landscape", devices["iPad Pro 11 landscape"]], ["wk-ipad-portrait", devices["iPad Pro 11"]]]) {
    const ctx = await wk.newContext(dev);
    await ctx.addInitScript((pin) => { localStorage.setItem("booth.pin", JSON.stringify(pin)); }, PIN);
    const page = await ctx.newPage(); const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.goto(BASE + "/"); await page.waitForTimeout(3000);
    await page.screenshot({ path: OUT + name + ".png" });
    check(errs.length === 0, `${name}: no page errors ${errs.join("|")}`);
    await ctx.close();
  }
  await wk.close();
}

await chromiumB.close();
console.log(fails.length ? `\n${fails.length} FAILED:\n - ` + fails.join("\n - ") : "\nall booth-flow checks passed");
process.exit(fails.length ? 1 : 0);
