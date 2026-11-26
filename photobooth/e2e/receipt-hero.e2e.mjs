// The printed receipt is the hero on every guest page: /s/<token>, /a/<token>, /a/<token>/<session>
// and the slideshow (?show=1). Real strips (the booth's own frames.js + dither) are uploaded to the
// local booth, then each page is checked (first + biggest image = strip.png, drawn pixelated) and
// screenshotted on iPhone, iPad and a 1920×1080 TV → e2e/out/receipt-hero/.
//   BASE=http://localhost:8788 PIN=1234 node e2e/receipt-hero.e2e.mjs
import { chromium, webkit, devices } from "playwright";
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { newSessionId } from "../public/archive.js";
import { makeSession } from "./strip-fixture.mjs";

const BASE = process.env.BASE ?? "http://localhost:8788";
const PIN = process.env.PIN ?? "1234";
const OUT = new URL("./out/receipt-hero/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log("•", ...a);
const H = { "x-booth-pin": PIN, "content-type": "application/json" };
const api = async (path, method = "GET", body) => (await fetch(BASE + path, { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
const origActive = (await api("/api/events")).active;

const cb = await chromium.launch();
const fx = await cb.newPage();
await fx.goto(BASE + "/api/version");
const ev = (await api("/api/events", "POST", { name: `Receipt hero ${Date.now().toString(36)}`, themes: ["turkey", "feast", "leaves"], theme: "turkey" })).event;
let seq = 0;
async function upload(id, { theme, shots, strip = true }) {
  const s = await makeSession(fx, { theme, shots, seed: ++seq, ticket: 40 + seq, qr: `${BASE}/a/${ev.share}/${id}` });
  const f = new FormData();
  f.append("meta", JSON.stringify({ id, event: ev.slug, theme, shots, capturedAt: new Date(parseInt(id.split("-")[0], 36)).toISOString() }));
  s.origs.forEach((o, i) => f.append(`orig-${i + 1}.jpg`, new Blob([o], { type: "image/jpeg" }), `orig-${i + 1}.jpg`));
  if (strip) f.append("strip.png", new Blob([s.strip], { type: "image/png" }), "strip.png");
  const r = await fetch(BASE + "/api/archive", { method: "POST", headers: { "x-booth-pin": PIN }, body: f });
  assert.ok(r.ok, "upload " + r.status);
}
const ids = [newSessionId(Date.now() - 60000), newSessionId(Date.now() - 40000), newSessionId(Date.now() - 20000), newSessionId(Date.now() - 5000)];
await upload(ids[0], { theme: "turkey", shots: 3 });
await upload(ids[1], { theme: "leaves", shots: 1 });
await upload(ids[2], { theme: "feast", shots: 2 });
await upload(ids[3], { theme: "turkey", shots: 1, strip: false });       // not printed yet
const share = async (id) => `${BASE}/s/${(await api(`/api/sessions/${id}/share`, "POST", {})).token}`;
const sUrl = await share(ids[0]), sPending = await share(ids[3]);
log("uploaded 4 sessions to", `${BASE}/a/${ev.share}`);

/** The first image inside `root` is strip.png, it is the biggest one there, and it is drawn dot for dot. */
async function heroIsReceipt(p, root, what) {
  await p.waitForFunction((root) => { const i = document.querySelector(`${root} img`); return i && i.complete && i.naturalWidth > 0; }, root, { timeout: 20000 });
  const h = await p.evaluate((root) => {
    const imgs = [...document.querySelectorAll(`${root} img`)].filter((i) => i.getBoundingClientRect().width > 0);
    const area = (i) => i.getBoundingClientRect().width * i.getBoundingClientRect().height;
    return { src: imgs[0].getAttribute("src"), biggest: imgs.every((i) => area(i) <= area(imgs[0]) + 1), ir: getComputedStyle(imgs[0]).imageRendering, w: imgs[0].naturalWidth };
  }, root);
  assert.match(h.src, /strip\.png/, `${what}: first image is the receipt`);
  assert.ok(h.biggest, `${what}: the receipt is the biggest image`);
  assert.equal(h.ir, "pixelated", `${what}: drawn dot for dot`);
  assert.equal(h.w, 576, `${what}: the 576-dot printed bitmap`);
}

for (const [bname, bt] of [["webkit", webkit], ["chromium", chromium]]) {
  const br = bname === "chromium" ? cb : await bt.launch();
  for (const [dname, dev] of [["iphone", devices["iPhone 15"]], ["ipad", devices["iPad Pro 11"]]]) {
    const ctx = await br.newContext(dev);
    const p = await ctx.newPage();
    const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    const tag = `${bname}-${dname}`;

    await p.goto(sUrl);
    await heroIsReceipt(p, "#hero", `${tag} /s/`);
    await p.waitForFunction(() => document.querySelectorAll("#thumbs img").length === 3 && [...document.querySelectorAll("#thumbs img")].every((i) => i.complete));
    await p.waitForTimeout(700);
    await p.screenshot({ path: `${OUT}${tag}-s-token.png` });
    await p.screenshot({ path: `${OUT}${tag}-s-token-full.png`, fullPage: true });

    await p.goto(sPending);
    await p.locator("#receipt.pending img.photo").waitFor();
    assert.match(await p.locator("#receipt.pending").textContent(), /Printing/);
    await p.waitForFunction(() => document.querySelector("#receipt img.photo").complete);
    await p.screenshot({ path: `${OUT}${tag}-s-token-pending.png` });

    await p.goto(`${BASE}/a/${ev.share}/${ids[0]}`);
    await heroIsReceipt(p, "#mineHero", `${tag} /a/<token>/<session>`);
    assert.match(await p.$eval("#mine img", (i) => i.getAttribute("src")), /strip\.png/, "first image in the 'yours' section is the receipt");
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}${tag}-a-session.png` });

    await p.goto(`${BASE}/a/${ev.share}`);
    await p.locator("#grid .tile img.bits").first().waitFor();
    await p.evaluate(async () => { for (const i of document.querySelectorAll("img[loading=lazy]")) i.loading = "eager"; await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))); });
    await p.waitForTimeout(800);   // let the cards pop in
    await p.screenshot({ path: `${OUT}${tag}-a-grid.png`, fullPage: true });
    await p.locator("#grid .tile:not(.colour)").first().click();
    await p.locator("#view.on.bw").waitFor();
    await p.waitForFunction(() => document.getElementById("viewImg").naturalWidth > 0);
    await p.screenshot({ path: `${OUT}${tag}-a-viewer.png` });
    assert.deepEqual(errs, [], `${tag}: page errors`);
    await ctx.close();
    log(tag, "/s/, pending, /a/<session>, grid, viewer ✓");
  }

  // Slideshow on a TV (1920×1080, 1×) and on an iPad.
  for (const [dname, opts] of [["tv", { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 }], ["ipad", devices["iPad Pro 11 landscape"]]]) {
    const ctx = await br.newContext(opts);
    const p = await ctx.newPage();
    const errs = []; p.on("pageerror", (e) => errs.push(e.message));
    await p.goto(`${BASE}/a/${ev.share}?show=1`);
    await p.locator("#show.on").waitFor();
    await heroIsReceipt(p, "#slide", `${bname}-${dname} slideshow`);
    assert.ok(await p.locator("#showQR svg").count(), "album QR corner");
    const first = await p.$eval("#slide img.bits", (i) => i.getAttribute("src"));
    if (dname === "tv") {
      const w = await p.$eval("#slide .receipt", (r) => parseFloat(getComputedStyle(r).width));
      assert.equal(w, 576, "TV: one screen pixel per printer dot");
    }
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${OUT}${bname}-${dname}-slideshow.png` });
    await p.waitForTimeout(5000);                       // mid-feed for tall strips
    await p.screenshot({ path: `${OUT}${bname}-${dname}-slideshow-feeding.png` });
    await p.waitForFunction((f) => { const i = document.querySelector("#slide img.bits") ?? document.querySelector("#slide img"); return i && i.getAttribute("src") !== f; }, first, { timeout: 60000 });
    log(`${bname}-${dname} slideshow: receipt hero, advances ✓`);
    assert.deepEqual(errs, [], "slideshow page errors");
    await ctx.close();
  }
  if (bname !== "chromium") await br.close();
}

await api("/api/events/active", "POST", { slug: origActive ?? null });
await cb.close();
log("receipt-hero e2e OK — screenshots in e2e/out/receipt-hero/");
