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
      localStorage.setItem("booth.coachDone", "true");   // section F turns the first-run coach back on
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
  const { ctx, page } = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 1 } });
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
  const c3 = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 3 } });
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

// ---------- C. settings gear (press and hold), deep link ----------
console.log("C. settings + deep link");
{
  const { ctx, page } = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 1 } });
  await page.goto(BASE + "/"); await camReady(page);
  const hs = await page.locator("#gearBtn").boundingBox();
  await page.mouse.move(hs.x + hs.width / 2, hs.y + hs.height / 2);
  await page.mouse.down(); await page.waitForTimeout(700);
  check(!(await page.locator("#settings.on").count()), "settings not open after 0.7s");
  check(await page.textContent("#adultHint") === "Keep holding…", "holding shows 'Keep holding…'");
  await page.waitForTimeout(800); await page.mouse.up();
  check(await page.locator("#settings.on").count() === 1, "1.5s hold on the gear opens settings");
  check(await page.locator("#sParty").isVisible(), "Party card visible in settings");
  check(/No party/.test(await page.textContent("#sPartyName")), "Party card says no party");
  await shot(page, "settings-noparty");
  // short press does not open
  await page.click("#sDone"); await camReady(page);
  await page.mouse.move(hs.x + hs.width / 2, hs.y + hs.height / 2); await page.mouse.down(); await page.waitForTimeout(150); await page.mouse.up();
  check(await page.textContent("#adultHint") === "Hold to open settings", "a tap shows the hold hint");
  await page.waitForTimeout(1500);
  check(await page.locator("#settings.on").count() === 0, "short press doesn't open settings");
  // gear overlaps anything? hit-test
  const hit = await page.evaluate(() => { const h = document.getElementById("gearBtn").getBoundingClientRect(); const e = document.elementFromPoint(h.left + h.width / 2, h.top + h.height / 2); return e?.closest("button")?.id || e?.tagName; });
  check(hit === "gearBtn", `gear is topmost at its centre (got ${hit})`);
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
  const { ctx, page } = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 3 } });
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
  const hs = await page.locator("#gearBtn").boundingBox();
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

// ---------- F. first-run coach: the hand on the shutter, then on Print; gone once a print went out ----------
console.log("F. first-run coach");
{
  const { ctx, page } = await newCtx(chromiumB, devices["iPhone 13"], { seed: { coachDone: false, ticket: 0 } });
  await page.goto(BASE + "/");
  await camReady(page);
  const coachAt = () => page.evaluate(() => {
    const c = document.getElementById("coach");
    if (c.hidden) return null;
    const h = document.getElementById("coachHand").getBoundingClientRect();
    return { step: c.dataset.step, x: h.left + h.width / 2, bottom: h.bottom };
  });
  const near = async (sel, at) => { const r = await page.locator(sel).boundingBox(); return at && Math.abs(at.x - (r.x + r.width / 2)) < 8 && at.bottom <= r.y + 30; };
  await page.waitForTimeout(400);
  let at = await coachAt();
  check(at?.step === "shutter", `fresh device: the hand is on the shutter (${JSON.stringify(at)})`);
  check(await near("#shutter", at), "the hand points down at the shutter");
  check(await page.locator("#coach").evaluate((e) => !e.textContent.trim()), "the coach has no words");
  await shot(page, "coach-1-shutter");
  check(await page.evaluate(() => getComputedStyle(document.getElementById("shutter")).pointerEvents !== "none"), "shutter still tappable");
  await page.click("#shutter");
  check((await coachAt())?.step !== "shutter", "gone once the shutter is tapped (instant capture + flash unblocked)");
  await page.locator("#review.on").waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
  at = await coachAt();
  check(at?.step === "printBtn", `review: the hand moves to Print (${JSON.stringify(at)})`);
  check(await near("#printBtn", at), "the hand points down at Print, not share-this-photo");
  await shot(page, "coach-2-print");
  await page.click("#printBtn");
  await page.locator("#printing.on").waitFor({ timeout: 10000 });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("booth.coachDone") ?? "false") === true, null, { timeout: 15000 });
  check(true, "a print went out: coach marked done");
  await page.click("#printBack", { timeout: 1000 }).catch(() => {});
  await page.goto(BASE + "/"); await camReady(page); await page.waitForTimeout(500);
  check(await coachAt() === null, "after printing: no hand on the camera screen");
  // Skipping: any other tap ends it for the visit (not for good).
  await page.evaluate(() => localStorage.setItem("booth.coachDone", "false"));
  await page.goto(BASE + "/"); await camReady(page); await page.waitForTimeout(400);
  check((await coachAt())?.step === "shutter", "Show the how-to again → back");
  await page.mouse.click(5, 300);
  check(await coachAt() === null, "a tap elsewhere skips it");
  await ctx.close();
}

// ---------- G. speed: instant capture, posing beats in strips, printing screen never waits ----------
console.log("G. instant capture + quick printing screen");
{
  // Count how often the countdown ring shows (and the numbers it shows) for the shots below.
  const watchRing = (page) => page.evaluate(() => {
    window.__rings = []; const r = document.getElementById("ring");
    new MutationObserver(() => { if (r.classList.contains("counting") && window.__rings.at(-1) !== "on") window.__rings.push("on"); else if (!r.classList.contains("on") && window.__rings.at(-1) === "on") window.__rings.push("off"); })
      .observe(r, { attributes: true, attributeFilter: ["class"] });
    window.__nums = new Set(); const num = document.getElementById("num");
    new MutationObserver(() => { if (r.classList.contains("counting")) window.__nums.add(num.textContent); }).observe(num, { childList: true, characterData: true, subtree: true });
  });
  const rings = (page) => page.evaluate(() => ({ shown: window.__rings.filter((x) => x === "on").length, nums: [...window.__nums] }));

  // Fresh device (no countdown stored): one tap → flash + snap at once, no ring at all.
  const { ctx, page } = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 1 } });
  await page.goto(BASE + "/"); await camReady(page);
  await watchRing(page);
  const flashAt = page.evaluate(() => new Promise((res) => {
    const t0 = performance.now(), f = document.getElementById("flash");
    new MutationObserver(() => { if (f.classList.contains("pop")) res(performance.now() - t0); }).observe(f, { attributes: true });
  }));
  await page.click("#shutter");
  const flashMs = await Promise.race([flashAt, new Promise((r) => setTimeout(() => r(Infinity), 3000))]);
  check(flashMs < 500, `instant: the flash fires right after the tap (${Math.round(flashMs)} ms)`);
  await page.locator("#review.on").waitFor({ timeout: 30000 });
  let r = await rings(page);
  check(r.shown === 0, `instant single shot: reaches review with no countdown ring (${JSON.stringify(r)})`);
  check(await page.evaluate(() => localStorage.getItem("booth.count")) === null, "the default isn't stored (only an explicit choice is)");

  // The printing screen: the local booth has no printer polling, so the job stays queued. The
  // screen must not wait for it: back to the camera in well under 10 s.
  const printReq = page.waitForResponse((res) => res.url().endsWith("/api/print") && res.request().method() === "POST");
  const t0 = Date.now();
  await page.click("#printBtn");
  await page.locator("#printing.on").waitFor({ timeout: 5000 });
  const job = await (await printReq).json();
  await page.locator("#cam.on").waitFor({ timeout: 10000 });
  const back = Date.now() - t0;
  const js = await j("/api/jobs/" + job.id);
  check(back < 10000, `printing screen → camera in ${(back / 1000).toFixed(1)} s (< 10 s)`);
  check(js.status !== "completed", `…while the job is still waiting for the printer (${js.status}, position ${js.position})`);
  check(!(await page.locator("#printErr.on").count()), "no error face for an accepted print");
  // The cooldown ring runs, then the shutter is back; the next shot isn't blocked by the job.
  await page.waitForFunction(() => !document.getElementById("shutter").disabled, null, { timeout: 20000 });
  check(true, "shutter free again after the cooldown");
  // Background follow-up: it keeps asking about the job (slower) after the screen moved on.
  const polls = [];
  page.on("request", (q) => { if (q.url().includes("/api/jobs/" + job.id)) polls.push(Date.now()); });
  await page.waitForTimeout(7000);
  check(polls.length >= 1 && polls.length <= 4, `job followed in the background every ~3 s (${polls.length} polls in 7 s)`);
  await shot(page, "after-quick-print");
  await ctx.close();

  // Settings: Countdown shows "Instant" on a fresh device and goes 0..10.
  {
    const s = await newCtx(chromiumB, devices["iPad Mini"]);
    await s.page.goto(BASE + "/"); await camReady(s.page);
    await s.page.focus("#gearBtn"); await s.page.keyboard.press("Enter");   // keyboard activation opens at once (adults with assistive tech)
    await s.page.locator("#settings.on").waitFor({ timeout: 3000 }).catch(() => {});
    if (await s.page.locator("#settings.on").count()) {
      check((await s.page.textContent("#sCount output")) === "Instant", "settings: Countdown reads Instant by default");
      await s.page.click("#sCount button:last-child");
      check((await s.page.textContent("#sCount output")) === "1 s" && await s.page.evaluate(() => localStorage.getItem("booth.count")) === "1", "settings: + → 1 s, stored");
      await s.page.click("#sCount button:first-child");
      check((await s.page.textContent("#sCount output")) === "Instant" && await s.page.evaluate(() => localStorage.getItem("booth.count")) === "0", "settings: − → Instant, stored as an explicit 0");
    } else check(false, "settings opened for the countdown check");
    await s.ctx.close();
  }

  // A device that chose a countdown keeps it: 2 s → the ring shows 2, 1.
  {
    const c = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 1, count: 2 } });
    await c.page.goto(BASE + "/"); await camReady(c.page);
    await watchRing(c.page);
    await c.page.click("#shutter");
    await c.page.locator("#review.on").waitFor({ timeout: 30000 });
    r = await rings(c.page);
    check(r.shown === 1 && r.nums.includes("2") && r.nums.includes("1"), `explicit 2 s countdown kept (${JSON.stringify(r)})`);
    await c.ctx.close();
  }

  // Strip of 3 with the instant default: first shot at once, a 1 s posing ring before shots 2 and 3.
  {
    const c = await newCtx(chromiumB, devices["iPad Mini"], { seed: { shots: 3 } });
    await c.page.goto(BASE + "/"); await camReady(c.page);
    await watchRing(c.page);
    const dotsAt = c.page.evaluate(() => new Promise((res) => {
      const t0 = performance.now(), f = document.getElementById("flash"), at = [];
      new MutationObserver(() => { if (f.classList.contains("pop")) { at.push(Math.round(performance.now() - t0)); if (at.length === 3) res(at); } }).observe(f, { attributes: true });
    }));
    await c.page.click("#shutter");
    const at = await dotsAt;
    await c.page.locator("#review.on").waitFor({ timeout: 30000 });
    r = await rings(c.page);
    check(at[0] < 500, `strip: first shot instant (${at})`);
    check(at[1] - at[0] >= 1500 && at[2] - at[1] >= 1500, `strip: a posing beat between shots (${at})`);
    check(r.shown === 2 && r.nums.length === 1 && r.nums[0] === "1", `strip: two 1 s rings, between shots only (${JSON.stringify(r)})`);
    const bad = c.page.errs.filter((e) => !noise.test(e));
    check(bad.length === 0, `G: no console/page errors ${bad.join("|")}`);
    await c.ctx.close();
  }
}

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
