// E2E: party page + public guest album (Chromium + WebKit, iPhone 15 viewport).
//   BASE=http://localhost:8788 PIN=1234 node e2e/album.e2e.mjs
// Uses uniquely named events; restores the active event at the end.
// Checks are soft: every failure is collected and printed, exit code 1 if any.
import { chromium, webkit, devices } from "playwright";
import { mkdirSync } from "node:fs";
import { newSessionId } from "../public/archive.js";
import { makeSession } from "./strip-fixture.mjs";

const BASE = process.env.BASE ?? "http://localhost:8788";
const PIN = process.env.PIN ?? "1234";
const OUT = new URL("./out/agent-album/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log("PASS", name); }
  catch (e) {
    const loc = (e.stack.match(/album\.e2e\.mjs:(\d+)/) ?? [])[1];
    const msg = `${e.message.split("\n")[0]} (line ${loc})`;
    results.push([false, name, msg]); console.log("FAIL", name, "::", msg);
  }
}
const eq = (a, b, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

const H = { "x-booth-pin": PIN, "content-type": "application/json" };
const api = async (path, method = "GET", body) => {
  const r = await fetch(BASE + path, { method, headers: H, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const origActive = (await api("/api/events")).body.active;

// ---- real images, drawn in a throwaway browser page ----
const cb = await chromium.launch();
const imgPage = await cb.newPage();
await imgPage.goto(BASE + "/api/version");   // booth origin: the strip fixture imports /frames.js
async function image(type, label, color) {
  const b64 = await imgPage.evaluate(async ([type, label, color]) => {
    const c = document.createElement("canvas"); c.width = type === "png" ? 576 : 640; c.height = type === "png" ? 900 : 480;
    const x = c.getContext("2d"); x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = "#000"; x.font = "bold 80px sans-serif"; x.fillText(label, 30, 120);
    const blob = await new Promise((r) => c.toBlob(r, type === "png" ? "image/png" : "image/jpeg", 0.8));
    return btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  }, [type, label, color]);
  return Buffer.from(b64, "base64");
}
const COLORS = ["#ff8", "#8ff", "#f8f", "#8f8", "#f88", "#88f"];
let seq = 0;
const newId = (ageMs = 5000) => newSessionId(Date.now() - ageMs - seq++ * 1000);
async function upload(slug, id, { shots = 2, strip = true, theme = "turkey" } = {}) {
  const f = new FormData();
  f.append("meta", JSON.stringify({ id, event: slug, theme, shots, capturedAt: new Date(parseInt(id.split("-")[0], 36)).toISOString(), ua: "secret-ua" }));
  for (let i = 1; i <= shots; i++) f.append(`orig-${i}.jpg`, new Blob([await image("jpeg", `${id.slice(-4)}#${i}`, COLORS[i % 6])], { type: "image/jpeg" }), `orig-${i}.jpg`);
  if (strip) f.append("strip.png", new Blob([(await makeSession(imgPage, { theme, shots: Math.min(shots, 4), seed: seq, ticket: seq })).strip], { type: "image/png" }), "strip.png");
  const r = await fetch(BASE + "/api/archive", { method: "POST", headers: { "x-booth-pin": PIN }, body: f });
  if (r.status !== 201 && r.status !== 200) throw new Error("upload " + r.status + " " + (await r.text()));
}
const mkEvent = async (name, extra = {}) => (await api("/api/events", "POST", { name, themes: ["turkey", "feast"], theme: "turkey", ...extra })).body.event;
const day = (id) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(parseInt(id.split("-")[0], 36));

// =====================================================================
// 1. API security
// =====================================================================
const secEv = await mkEvent(`SEC ${RUN}`), secOther = await mkEvent(`SECOTHER ${RUN}`);
const sIn = newId(), sOut = newId();
await upload(secEv.slug, sIn); await upload(secOther.slug, sOut);
const album = async (tok) => (await fetch(`${BASE}/api/album/${tok}`)).json();
await check("api: /api/events needs PIN (none/wrong -> 401)", async () => {
  eq((await fetch(BASE + "/api/events")).status, 401);
  eq((await fetch(BASE + "/api/events", { headers: { "x-booth-pin": "0000" } })).status, 401);
  eq((await fetch(BASE + "/api/events/active", { method: "POST", body: "{}" })).status, 401);
  eq((await fetch(`${BASE}/api/events/${secEv.slug}/share`, { method: "POST" })).status, 401);
  eq((await fetch(`${BASE}/api/events/${secEv.slug}/detach`, { method: "POST", body: "{}" })).status, 401);
});
await check("api: album file refuses other-event keys / meta.json / traversal", async () => {
  const f = (k, tok = secEv.share) => fetch(`${BASE}/api/album/${tok}/file?key=${k}`);
  const good = `${day(sIn)}/${sIn}/orig-1.jpg`, bad = `${day(sOut)}/${sOut}/orig-1.jpg`;
  eq((await f(encodeURIComponent(good))).status, 200, "own key");
  eq((await f(encodeURIComponent(bad))).status, 404, "other event key");
  eq((await f(encodeURIComponent(bad), secOther.share)).status, 200, "other token own key");
  for (const k of [`${day(sIn)}/${sIn}/meta.json`, "../x", "..%2f..%2fevents%2f" + secEv.slug + "%2fevent.json", `${day(sIn)}/${sIn}/../${sOut}/orig-1.jpg`, `${day(sIn)}/${sIn}/orig-1.jpg/../../${sOut}/orig-1.jpg`, `events/${secEv.slug}/event.json`, `share/${secOther.share}`, `active-event`, "", `${day(sIn)}/${sIn}/orig-1.jpg%00.png`, "%2e%2e/%2e%2e/etc/passwd"]) {
    const s = (await f(k.includes("%") ? k : encodeURIComponent(k))).status;
    ok(s === 400 || s === 404, `key ${JSON.stringify(k)} -> ${s}`);
  }
  eq((await fetch(`${BASE}/api/album/${secEv.share}/file`)).status, 400, "no key");
  ok([401, 404].includes((await fetch(`${BASE}/api/album/ABCDEFGHJKMN`)).status), "uppercase token");
  eq((await fetch(`${BASE}/api/album/${secEv.share}`, { method: "POST" })).status, 405);
});
await check("api: album listing hides ua + token; only own event's sessions", async () => {
  const a = await album(secEv.share);
  eq(a.sessions.map((s) => s.id), [sIn]);
  ok(!JSON.stringify(a).includes("secret-ua"), "ua leaked");
  ok(!JSON.stringify(a).includes(secEv.share), "share token echoed");
});
await check("api: bad event inputs rejected", async () => {
  eq((await api("/api/events", "POST", { name: "x", themes: ["../x"] })).status, 400);
  eq((await api("/api/events", "POST", { name: "x", theme: "nope!!" })).status, 400);
  eq((await api(`/api/events/${secEv.slug}`, "PUT", { themes: ["turkey"], theme: "feast" })).status, 400);
  eq((await api(`/api/events/${secEv.slug}/attach`, "POST", { day: "2026-13-45" })).status, 400);
  eq((await api("/api/events/active", "POST", { slug: "does-not-exist" })).status, 404);
});
await check("api: PUT can clear default theme / switching to 'all' frames keeps a stale default", async () => {
  const e = await mkEvent(`CLEAR ${RUN}`);
  const r = await api(`/api/events/${e.slug}`, "PUT", { themes: [], theme: null });
  eq(r.body.event.themes, []);
  eq(r.body.event.theme ?? null, null, "theme should be cleared when party offers all frames (party.html sends theme:null)");
});

// =====================================================================
// 2. party.html UI (Chromium desktop)
// =====================================================================
const xssName = `<img src=x onerror="window.__xss=1"> ${RUN}`;
{
  const ctx = await cb.newContext({ viewport: { width: 900, height: 1200 }, permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript((pin) => { if (!localStorage.getItem("booth.pin")) localStorage.setItem("booth.pin", JSON.stringify(pin)); }, PIN);
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  let dialogs = [];
  p.on("dialog", (d) => { dialogs.push(d.message()); d.accept(d.type() === "prompt" ? (p.__promptAnswer ?? "") : undefined); });
  await p.goto(BASE + "/party.html");
  const chips = () => p.$$eval("#edThemes button", (bs) => ({ sel: bs.filter((b) => b.classList.contains("sel")).map((b) => b.dataset.k), def: bs.filter((b) => b.classList.contains("def")).map((b) => b.dataset.k) }));
  let slug;
  await check("party: XSS event name renders as text; create via UI w/ Thanksgiving default", async () => {
    await p.getByRole("button", { name: "➕ New party" }).click();
    eq(await chips(), { sel: ["turkey", "feast", "leaves", "starry", "harvest"], def: ["turkey"] });
    await p.fill("#edName", xssName); await p.fill("#edFooter", "foot<b>x</b>");
    await p.screenshot({ path: OUT + "party-editor.png" });
    await p.click("#edSave");
    await p.locator(".ev.active").first().waitFor();
    const card = p.locator(".ev", { hasText: RUN }).first();
    ok((await card.locator("h2").textContent()).includes("<img src=x"), "name not shown as text");
    eq(await p.evaluate(() => window.__xss), undefined, "XSS executed");
    eq(await p.locator(".ev h2 img, .ev .muted b").count(), 0, "injected elements");
    slug = await card.getAttribute("data-slug");
    await p.screenshot({ path: OUT + "party-list.png", fullPage: true });
  });
  await check("party: chips: tap offered = ★ default; tap ★ = remove; None / All / Thanksgiving", async () => {
    await p.locator(`.ev[data-slug="${slug}"] button[data-act=edit]`).click();
    await p.click('#edThemes [data-k="starry"]');           // offered -> default
    eq((await chips()).def, ["starry"]);
    await p.click('#edThemes [data-k="starry"]');           // default -> removed, default falls back
    let c = await chips(); ok(!c.sel.includes("starry"), "starry removed"); eq(c.def, [c.sel[0]]);
    await p.click('#edThemes [data-k="dino"]');             // new theme becomes selected, not default
    c = await chips(); ok(c.sel.includes("dino")); ok(!c.def.includes("dino"));
    await p.click("#edNone"); eq(await chips(), { sel: [], def: [] });
    await p.click("#edAll"); c = await chips(); ok(c.sel.length > 5 && c.def.length === 1, "All -> one default " + JSON.stringify(c.def));
    await p.click("#edThanks"); eq(await chips(), { sel: ["turkey", "feast", "leaves", "starry", "harvest"], def: ["turkey"] });
    await p.click('#edThemes [data-k="harvest"]'); await p.click('#edThemes [data-k="harvest"]');   // make harvest default then remove it
    c = await chips(); ok(!c.sel.includes("harvest")); ok(c.def.length === 1 && c.sel.includes(c.def[0]), "default must stay an offered frame: " + JSON.stringify(c));
    await p.click("#edThanks");
    await p.click('#edThemes [data-k="leaves"]');           // leaves -> default
    await p.click("#edSave"); await p.waitForFunction(() => !document.getElementById("editor").open);
    const e = (await api(`/api/events/${slug}`)).body.event;
    eq(e.theme, "leaves"); eq(e.themes, ["turkey", "feast", "leaves", "starry", "harvest"]);
  });
  await check("party: edit -> None, save: themes=[] and no stale default", async () => {
    await p.locator(`.ev[data-slug="${slug}"] button[data-act=edit]`).click();
    await p.click("#edNone"); await p.click("#edSave"); await p.waitForFunction(() => !document.getElementById("editor").open);
    const e = (await api(`/api/events/${slug}`)).body.event;
    eq(e.themes, []); eq(e.theme ?? null, null, "stale default theme after None");
  });
  await check("party: edit save with active unchecked stops the booth; activate/stop buttons", async () => {
    if (await p.locator(`.ev[data-slug="${slug}"] button[data-act=stop]`).count()) await p.locator(`.ev[data-slug="${slug}"] button[data-act=stop]`).click();
    await p.locator(`.ev[data-slug="${slug}"] button[data-act=activate]`).click();
    await p.locator(`.ev[data-slug="${slug}"].active`).waitFor();
    eq((await api("/api/events/active")).body.event.slug, slug);
    await p.locator(`.ev[data-slug="${slug}"] button[data-act=stop]`).click();
    await p.locator(`.ev[data-slug="${slug}"]:not(.active)`).waitFor();
    eq((await api("/api/events/active")).body.event, null);
  });
  await check("party: copy link puts album URL on clipboard", async () => {
    await p.locator(`.ev[data-slug="${slug}"] button[data-act=copy]`).click();
    const e = (await api(`/api/events/${slug}`)).body.event;
    eq(await p.evaluate(() => navigator.clipboard.readText()), `${BASE}/a/${e.share}`);
  });
  await check("party: attach a day adds sessions to the album", async () => {
    const id = newId(); await upload(secOther.slug, id);   // belongs to another event, same day
    p.__promptAnswer = day(id);
    await p.locator(`.ev[data-slug="${slug}"] button[data-act=attach]`).click();
    await p.locator("#status", { hasText: "Added" }).waitFor();
    const e = (await api(`/api/events/${slug}`)).body.event;
    const a = await album(e.share);
    ok(a.sessions.some((s) => s.id === id), "attached session missing");
    p.__promptAnswer = "not a day";
    await p.locator(`.ev[data-slug="${slug}"] button[data-act=attach]`).click();
    await p.locator("#status", { hasText: "Failed" }).waitFor();
  });
  await check("party: album sign + 'use your own phone' sign; thermal prints enqueue", async () => {
    await p.locator(`.ev[data-slug="${slug}"] button[data-act=sign]`).click();
    await p.locator("#poster .sg-album .qr svg").waitFor();
    ok((await p.locator("#poster h1").textContent()).includes("<img"), "sign title as text");
    eq(await p.locator("#poster .sg-qrcard svg").count(), 1);
    eq(await p.locator("#poster .sg-page").evaluate((el) => /\p{Extended_Pictographic}/u.test(el.textContent)), false, "no emoji on the sign");
    await p.screenshot({ path: OUT + "sign.png", fullPage: true });
    await p.click("#signThermal");
    await p.locator("#status", { hasText: "Sign sent" }).waitFor({ timeout: 15000 });
    // Switch to the web-booth sign: its QR is the unlocked booth link; the PIN is not printed as text.
    await p.click("#signSwitch");
    await p.locator("#poster .sg-web .qr svg").waitFor();
    ok(!(await p.locator("#poster .sg-page").textContent()).includes(PIN), "PIN only inside the QR");
    await p.screenshot({ path: OUT + "sign-web.png", fullPage: true });
    await p.evaluate(() => { document.getElementById("status").textContent = ""; });
    await p.click("#signThermal");
    await p.locator("#status", { hasText: "Sign sent" }).waitFor({ timeout: 15000 });
    await p.click("#signBack");
    // Header button opens the web sign without a party.
    await p.click("#boothSign");
    await p.locator("#poster .sg-web .qr svg").waitFor();
    ok(await p.locator("#signSwitch").isHidden(), "no album to switch to");
    await p.click("#signBack");
  });
  await check("party: rotate link -> old /a/<token> 404 + 'Album not found'", async () => {
    const before = (await api(`/api/events/${slug}`)).body.event.share;
    await p.locator(`.ev[data-slug="${slug}"] button[data-act=rotate]`).click();
    await p.locator("#status", { hasText: "New album link" }).waitFor();
    const after = (await api(`/api/events/${slug}`)).body.event.share;
    ok(before !== after);
    eq((await fetch(`${BASE}/api/album/${before}`)).status, 404);
    ok((await p.locator(`.ev[data-slug="${slug}"] .link`).textContent()).endsWith(after), "list shows new link");
    const g = await ctx.newPage(); await g.goto(`${BASE}/a/${before}`);
    await g.locator("#name", { hasText: "Album not found" }).waitFor();
    ok((await g.locator("#status").textContent()).includes("doesn't work"));
    await g.screenshot({ path: OUT + "album-gone.png" }); await g.close();
    const g2 = await ctx.newPage(); await g2.goto(`${BASE}/a/${after}`); await g2.locator("#name", { hasText: "<img" }).waitFor();
    eq(await g2.evaluate(() => window.__xss), undefined, "album XSS"); eq(await g2.locator("h1 img").count(), 0);
    ok((await g2.title()).includes("<img"), "title text");
    await g2.close();
  });
  await check("party: wrong PIN -> lock screen", async () => {
    const c2 = await cb.newContext(); await c2.addInitScript(() => localStorage.setItem("booth.pin", '"9999"'));
    const q = await c2.newPage(); await q.goto(BASE + "/party.html"); await q.locator("#lock:not([hidden])").waitFor(); await c2.close();
  });
  await check("party: no uncaught page errors", async () => eq(errs, []));
  await ctx.close();
}

// =====================================================================
// 3. Guest album on iPhone 15 — Chromium and WebKit
// =====================================================================
for (const [bname, bt] of [["chromium", chromium], ["webkit", webkit]]) {
  const T = (n) => `${bname}: ${n}`;
  let br;
  try { br = bname === "chromium" ? cb : await bt.launch(); } catch (e) { results.push([false, T("launch"), e.message.split("\n")[0]]); continue; }
  const ev = await mkEvent(`Album ${bname} ${RUN}`);
  const ids = [newId(), newId(), newId()];
  for (const id of ids) await upload(ev.slug, id, { shots: 2 });
  await upload(ev.slug, newId(), { shots: 1, strip: false });
  const ctx = await br.newContext({ ...devices["iPhone 15"], acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = []; p.on("pageerror", (e) => errs.push(e.message));
  p.on("dialog", (d) => d.accept());
  await p.goto(`${BASE}/a/${ev.share}`);
  await p.locator("#grid .card").first().waitFor();

  await check(T("grid: 4 cards, receipt tiles, no horizontal overflow, header"), async () => {
    eq(await p.locator("#grid .card").count(), 4);
    eq(await p.locator("#grid .tile").count(), 4, "tiles"); eq(await p.locator("#grid .tile:not(.colour) img.bits").count(), 3, "receipt tiles");
    eq(await p.locator("#grid .tile.colour .chip").count(), 1, "not printed yet: colour photo + printing chip");
    eq(await p.locator("#grid .mini .thumb").count(), 6, "small colour thumbs");
    const firsts = await p.$$eval("#grid .card", (cs) => cs.map((c) => c.querySelector("img")?.getAttribute("src") ?? ""));
    eq(firsts.filter((f) => f.includes("strip.png")).length, 3, "each printed card leads with its receipt");
    const o = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ok(o <= 0, "horizontal overflow " + o + "px");
    ok((await p.locator("#sub").textContent()).includes("4 photo sessions"));
    await p.screenshot({ path: OUT + `${bname}-grid.png`, fullPage: true });
  });
  await check(T("viewer: open, next/prev wrap, keyboard, close"), async () => {
    const pics = 10;
    await p.locator("#grid .tile").first().click();
    await p.locator("#view.on.bw").waitFor();
    ok((await p.getAttribute("#viewImg", "src")).includes("strip.png"), "viewer opens on the receipt");
    const src0 = await p.getAttribute("#viewImg", "src");
    await p.click("#next"); ok((await p.getAttribute("#viewImg", "src")) !== src0, "next");
    await p.click("#prev"); eq(await p.getAttribute("#viewImg", "src"), src0);
    await p.click("#prev"); const last = await p.getAttribute("#viewImg", "src"); ok(last !== src0, "wraps backwards");
    await p.click("#next");
    for (let i = 0; i < pics; i++) await p.click("#next");
    eq(await p.getAttribute("#viewImg", "src"), src0, `full cycle of ${pics}`);
    await p.waitForFunction(() => document.getElementById("viewImg").naturalWidth > 0);
    await p.screenshot({ path: OUT + `${bname}-viewer.png` });
    const box = await p.locator("#viewImg").boundingBox(); ok(box.width <= 393 + 1, "viewer image wider than screen");
    const save = await p.locator("#viewSave"); ok((await save.getAttribute("href")).includes("&dl=1"));
    const r = await fetch(BASE + await save.getAttribute("href")); ok((r.headers.get("content-disposition") ?? "").startsWith("attachment"), "dl=1 not attachment");
    eq((await fetch(BASE + (await save.getAttribute("href")).replace("&dl=1", ""))).headers.get("content-disposition"), null);
    // swipe: synthetic touch events
    const swipe = (dx) => p.evaluate((dx) => {
      const v = document.getElementById("view");
      const mk = (t, x) => { // WebKit has no Touch constructor: fake the fields the page reads
        let e; try { e = new TouchEvent(t, { bubbles: true, cancelable: true, touches: t === "touchend" ? [] : [new Touch({ identifier: 1, target: v, clientX: x, clientY: 300 })], changedTouches: [new Touch({ identifier: 1, target: v, clientX: x, clientY: 300 })] }); }
        catch { e = new Event(t, { bubbles: true, cancelable: true }); const pt = [{ clientX: x, clientY: 300 }]; Object.defineProperty(e, "touches", { value: t === "touchend" ? [] : pt }); Object.defineProperty(e, "changedTouches", { value: pt }); }
        return e;
      };
      v.dispatchEvent(mk("touchstart", 200)); v.dispatchEvent(mk("touchend", 200 + dx));
    }, dx);
    await swipe(-120); ok((await p.getAttribute("#viewImg", "src")) !== src0, "swipe left -> next");
    await swipe(120); eq(await p.getAttribute("#viewImg", "src"), src0, "swipe right -> prev");
    await swipe(20); eq(await p.getAttribute("#viewImg", "src"), src0, "tiny swipe ignored");
    await p.keyboard.press("Escape"); await p.locator("#view:not(.on)").waitFor({ state: "attached" });
  });
  await check(T("zip: Download all -> valid zip with every picture"), async () => {
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.click("#zip")]);
    ok(dl.suggestedFilename().endsWith(".zip"), dl.suggestedFilename());
    const path = await dl.path(); const fs = await import("node:fs");
    const buf = fs.readFileSync(path); eq(buf.readUInt32LE(0), 0x04034b50, "PK header");
    let n = 0; for (let i = 0; i < buf.length - 4; i++) if (buf.readUInt32LE(i) === 0x02014b50) n++;
    eq(n, 10, "zip entries");
  });
  await check(T("slideshow ?show=1: auto-starts, receipt is the hero + QR, advances, exits"), async () => {
    const s = await ctx.newPage(); await s.goto(`${BASE}/a/${ev.share}?show=1`);
    await s.locator("#show.on").waitFor();
    const heroSrc = () => s.evaluate(() => document.querySelector("#slide img.bits")?.getAttribute("src") ?? document.querySelector("#slide img")?.getAttribute("src") ?? null);
    await s.waitForFunction(() => document.querySelector("#slide .slot img.bits")?.naturalWidth > 0, null, { timeout: 10000 });
    ok(await s.locator("#showQR svg").count(), "QR");
    ok((await heroSrc()).includes("strip.png"), "slide hero is the receipt");
    await s.screenshot({ path: OUT + `${bname}-slideshow.png` });
    const first = await heroSrc();
    await s.waitForFunction((f) => { const i = document.querySelector("#slide img.bits") ?? document.querySelector("#slide img"); return i && i.getAttribute("src") !== f; }, first, { timeout: 45000 });
    await s.click("#showX"); await s.locator("#show:not(.on)").waitFor({ state: "attached" }); await s.close();
  });
  await check(T("deep link before upload: waiting state, then appears"), async () => {
    const late = newId(1000);
    const d = await ctx.newPage(); await d.goto(`${BASE}/a/${ev.share}/${late}`);
    await d.locator("#mine .wait", { hasText: "on their way" }).waitFor();
    await d.screenshot({ path: OUT + `${bname}-waiting.png` });
    await upload(ev.slug, late, { shots: 3 });
    await d.locator("#mine h2", { hasText: "Your receipt" }).waitFor({ timeout: 15000 });
    await d.locator("#mineHero img.bits").waitFor({ timeout: 15000 });
    eq(await d.locator("#mine .thumb").count(), 3);
    ok((await d.$eval("#mine img", (i) => i.getAttribute("src"))).includes("strip.png"), "first image in 'yours' is the receipt");
    ok(await d.locator(`#s-${late}.me`).count(), "own card highlighted");
    await d.screenshot({ path: OUT + `${bname}-mine.png` });
    const [dl] = await Promise.all([d.waitForEvent("download", { timeout: 20000 }), d.click("#saveMine")]);
    ok(dl.suggestedFilename().endsWith("-mine.zip"));
    await d.close();
  });
  await check(T("deep link, printed later: printing… placeholder with the colour photo, then the receipt"), async () => {
    const late = newId(1000);
    await upload(ev.slug, late, { shots: 1, strip: false });
    const d = await ctx.newPage(); await d.goto(`${BASE}/a/${ev.share}/${late}`);
    await d.locator("#mine .receipt.pending img.photo").waitFor({ timeout: 10000 });
    ok((await d.locator("#mine .receipt.pending").textContent()).includes("Printing"), "printing… text");
    await d.screenshot({ path: OUT + `${bname}-mine-pending.png` });
    await upload(ev.slug, late, { shots: 1, strip: true });
    await d.locator("#mineHero img.bits").waitFor({ timeout: 15000 });
    await d.close();
  });
  await check(T("deep link to a session from another event never resolves (stays waiting, no leak)"), async () => {
    const d = await ctx.newPage(); await d.goto(`${BASE}/a/${ev.share}/${sOut}`);
    await d.locator("#mine .wait").waitFor(); eq(await d.locator("#mine .thumb").count(), 0); await d.close();
  });
  await check(T("host hide 🙈: only with PIN; removes card; files then 404"), async () => {
    const guest = await br.newContext({ ...devices["iPhone 15"] }); const g = await guest.newPage(); await g.goto(`${BASE}/a/${ev.share}`);
    await g.locator("#grid .card").first().waitFor(); eq(await g.locator("[data-hide]").count(), 0, "guests must not see hide"); await guest.close();
    await ctx.addInitScript((pin) => localStorage.setItem("booth.pin", JSON.stringify(pin)), PIN);
    const h = await ctx.newPage(); h.on("dialog", (d) => d.accept()); await h.goto(`${BASE}/a/${ev.share}`); await h.locator("#grid .card").first().waitFor();
    const n0 = await h.locator("#grid .card").count();
    const victim = await h.locator("#grid .card [data-hide]").first().getAttribute("data-hide");
    const a0 = await album(ev.share); const key = a0.sessions.find((s) => s.id === victim).files["orig-1.jpg"];
    await h.locator(`[data-hide="${victim}"]`).click();
    await h.waitForFunction((n) => document.querySelectorAll("#grid .card").length === n, n0 - 1);
    eq(await h.locator(`#s-${victim}`).count(), 0);
    eq((await fetch(`${BASE}/api/album/${ev.share}/file?key=${encodeURIComponent(key)}`)).status, 404, "hidden file still served");
    await h.screenshot({ path: OUT + `${bname}-after-hide.png`, fullPage: true }); await h.close();
  });
  await check(T("no uncaught page errors"), async () => eq(errs, []));
  await ctx.close(); if (bname !== "chromium") await br.close();
}

// ---- restore ----
await api("/api/events/active", "POST", { slug: origActive ?? null });
await cb.close();
const bad = results.filter((r) => !r[0]);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
for (const b of bad) console.log("  FAIL", b[1], "::", b[2]);
process.exit(bad.length ? 1 : 0);
