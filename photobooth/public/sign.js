// Letter-size party signs in the "Thermal Arcade" look (DESIGN.md; same design as the iOS app's
// TestFlight sign, microapps `micro sign`): a cream card with candy confetti, a white sticker card
// holding a pure black-on-white QR with a "Scan me" tab, drawn art from icons.js, Lilita headings.
// Pure strings, no DOM at import (unit-tested under node). The CSS lives in party.html (`.sg-*`,
// tokens only); scripts/web-sign.mjs renders the same page to a PDF.
//
//   webSignHTML({ server, pin })        "use the booth on your own phone": QR → <origin>/#pin=<PIN>
//   albumSignHTML({ name, date, url })  the party album: QR → /a/<token>
//
// The PIN only ever goes into the QR, never into visible text on the sign.

import { K, DRAWN } from "./icons.js";
import { qrSVG } from "./qr.js";
import { webBoothLink } from "./share.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const st = (w = 6) => `stroke="${K.ink}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
const f1 = (v) => v.toFixed(1);
function starPts(cx, cy, ro, ri, n, rot = 0) {
  const p = [];
  for (let i = 0; i < 2 * n; i++) {
    const r = i % 2 ? ri : ro, a = ((rot + (180 * i) / n - 90) * Math.PI) / 180;
    p.push(f1(cx + r * Math.cos(a)) + "," + f1(cy + r * Math.sin(a)));
  }
  return p.join(" ");
}
/** "Outlined stroke": a fat ink line under a thinner colour line (as in icons.js). */
const ol = (d, c, w = 8) => `<path d="${d}" fill="none" stroke="${K.ink}" stroke-width="${w + 9}" stroke-linecap="round" stroke-linejoin="round"/>` +
                            `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

// ---------- art (100×100 boxes; the drawn icon set plus two sign-only drawings) ----------
const ART = {
  ...DRAWN,
  /** A phone whose screen shows a code in viewfinder corners (the TestFlight sign's "Scan"). */
  scan: () => {
    const q = [0, 2, 4, 6, 7, 8, 1].map((i) => `<rect x="${37 + 6 * (i % 3)}" y="${38 + 6 * Math.floor(i / 3)}" width="5" height="5" fill="${K.ink}"/>`).join("");
    return `<g transform="rotate(-6 50 50)"><rect x="24" y="6" width="52" height="88" rx="11" fill="${K.white}" ${st()}/>
      <rect x="31" y="18" width="38" height="58" rx="4" fill="${K.sky}" ${st(4)}/><path d="M43 12 H57" ${st(4.5)}/>
      <circle cx="50" cy="85" r="3.5" fill="${K.ink}"/><rect x="35" y="36" width="30" height="22" fill="${K.white}"/>${q}
      <path d="M34 34 V30 H39 M61 30 H66 V34 M66 60 V64 H61 M39 64 H34 V60" fill="none" stroke="${K.white}" stroke-width="3.5" stroke-linecap="round"/></g>`;
  },
  /** "Allow the camera": a phone showing the permission prompt, the Allow button ticked. */
  allow: () => `<g transform="rotate(-6 50 50)"><rect x="18" y="6" width="56" height="88" rx="11" fill="${K.white}" ${st()}/>
      <rect x="25" y="18" width="42" height="60" rx="4" fill="${K.sky}" ${st(4)}/><path d="M39 12 H53" ${st(4.5)}/><circle cx="46" cy="86" r="3.5" fill="${K.ink}"/>
      <rect x="29" y="30" width="34" height="36" rx="5" fill="${K.white}" ${st(4)}/><path d="M35 39 H57 M35 46 H51" ${st(3.5)}/>
      <rect x="33" y="53" width="26" height="9" rx="4.5" fill="${K.mint}" ${st(3.5)}/></g>
      <circle cx="74" cy="72" r="18" fill="${K.mint}" ${st()}/>` + ol("M65 72 L72 79 L84 65", K.white, 6),
  /** Your phone is the camera: a phone with the booth camera on its screen. */
  phoneCam: () => `<g transform="rotate(-8 50 50)"><rect x="20" y="4" width="60" height="92" rx="12" fill="${K.white}" ${st()}/>
      <rect x="27" y="16" width="46" height="66" rx="5" fill="${K.paper}" ${st(4)}/><path d="M42 10 H58" ${st(4.5)}/>
      <circle cx="50" cy="89" r="3.5" fill="${K.ink}"/><g transform="translate(25 28) scale(.5)">${DRAWN.shutter()}</g></g>`,
};

/** One drawing as inline SVG with its hard ink shadow: the same drawing, every colour → ink, offset (vector, no filter). */
export function art(name, cls = "", dx = 5, box = "-8 -8 116 116") {
  const body = ART[name]();
  const shadow = body.replace(/#[0-9A-Fa-f]{6}\b/g, K.ink);
  return `<svg class="${cls}" viewBox="${box}" aria-hidden="true" focusable="false"><g transform="translate(${dx} ${dx})">${shadow}</g>${body}</svg>`;
}

// ---------- pieces ----------
function confetti(bits) {
  return bits.map(([kind, x, y, col, s]) => {
    let g;
    if (kind === "spark") g = `<polygon points="${starPts(20, 20, 16 * s, 6.5 * s, 4, 12)}" fill="${col}" ${st(3.5)}/>`;
    else if (kind === "dot") g = `<circle cx="20" cy="20" r="${8 * s}" fill="${col}" ${st(3.5)}/>`;
    else g = ol("M4 24 q6 -12 12 0 t12 0 t12 0", col, 4.5).replace(/stroke-width="13.5"/, 'stroke-width="10"');
    return `<svg class="sg-bit" style="left:${x}in;top:${y}in" viewBox="0 0 44 40" aria-hidden="true">${g}</svg>`;
  }).join("");
}
const BURST = `<svg class="sg-burst" viewBox="-100 -100 200 200" aria-hidden="true"><g fill="${K.white}" opacity="0.75">
  <path d="M0 0 L-6 -100 L6 -100 Z M0 0 L94 -34 L98 -22 Z M0 0 L58 81 L48 88 Z M0 0 L-48 88 L-58 81 Z M0 0 L-98 -22 L-94 -34 Z
           M0 0 L40 -92 L51 -86 Z M0 0 L100 6 L100 18 Z M0 0 L6 100 L-6 100 Z M0 0 L-100 18 L-100 6 Z M0 0 L-51 -86 L-40 -92 Z
           M0 0 L82 -58 L88 -48 Z M0 0 L86 51 L79 61 Z M0 0 L-79 61 L-86 51 Z M0 0 L-88 -48 L-82 -58 Z"/></g></svg>`;

/** Big outlined title (SVG text: accent fill, ink outline, ink offset shadow). One or two lines.
 *  The viewBox is a guess from the length; fitSignTitles() tightens it once the font is in. */
function title(text, fill) {
  const t = String(text).trim();
  let lines = [t];
  if (t.length > 20) {   // two lines, split at the space nearest the middle
    const sp = [...t.matchAll(/\s/g)].map((m) => m.index);
    if (sp.length) { const cut = sp.reduce((a, b) => (Math.abs(b - t.length / 2) < Math.abs(a - t.length / 2) ? b : a)); lines = [t.slice(0, cut), t.slice(cut + 1)]; }
  }
  const fs = 128, lh = 132, w = Math.max(300, Math.max(...lines.map((l) => l.length)) * fs * 0.52 + 40), h = 40 + lines.length * lh;
  const txt = (dx, attrs) => `<text x="${w / 2 + dx}" y="${130 + dx}" text-anchor="middle" font-size="${fs}" ${attrs}>` +
    lines.map((l, i) => `<tspan x="${w / 2 + dx}" dy="${i ? lh : 0}">${esc(l)}</tspan>`).join("") + `</text>`;
  return `<h1 class="sg-title${lines.length > 1 ? " two" : ""}"><svg viewBox="0 0 ${f1(w)} ${h}" role="img" aria-label="${esc(t)}">` +
    txt(8, `fill="${K.ink}" stroke="${K.ink}" stroke-width="18" stroke-linejoin="round" aria-hidden="true"`) +
    txt(0, `fill="${fill}" stroke="${K.ink}" stroke-width="16" stroke-linejoin="round" paint-order="stroke"`) + `</svg></h1>`;
}

/** The QR on its white sticker card, an accent card tilted behind it, and the "Scan me" tab.
 *  Modules stay pure #000 on #fff with a 3-module quiet zone inside the svg, plus the card's white padding. */
const qrBlock = (url, tab) => `<div class="sg-qrwrap"><div class="qr sg-qrcard">${qrSVG(url, 3)}</div><div class="sg-scanme">${tab}</div></div>`;

const step = (n, head, body, pic) =>
  `<li class="sg-step"><span class="sg-num">${n}</span>${art(pic, "sg-step-art")}<h3>${head}</h3><p>${body}</p></li>`;

const page = (kind, inner) => `<div class="sg-page sg-${kind}"><div class="sg-card">${BURST}${inner}</div></div>`;

// ---------- the signs ----------

/** "Use the booth on your own phone": the web booth, already unlocked (QR → <origin>/#pin=<PIN>). */
export function webSignHTML({ server, pin }) {
  const url = webBoothLink(server, pin);
  const host = new URL(server).host;
  return page("web", confetti([
    ["spark", .35, .35, K.pink, 1], ["dot", 7.0, .3, K.mint, 1], ["spark", 7.15, 1.5, K.sky, .8], ["dot", .3, 1.75, K.sun, 1],
    ["squig", 6.3, .55, K.tomato, 1], ["spark", 4.9, .1, K.sun, .7], ["spark", 1.2, .15, K.mint, .6],
    ["dot", .2, 9.7, K.pink, .8], ["spark", 7.1, 9.62, K.mint, .75], ["squig", 2.3, 9.74, K.sky, .9],
  ]) + `
<div class="sg-head">${title("Photo Booth", K.pink)}
  <div class="sg-pill">Use your own phone <b>no app needed</b></div></div>
<section class="sg-mid">
  ${qrBlock(url, "Scan me with your Camera")}
  <div class="sg-side">
    ${art("phoneCam", "sg-side-art")}
    <p class="sg-say">Your phone is the camera</p>
    <svg class="sg-arrow" viewBox="0 0 60 70" aria-hidden="true">${ol("M18 6 C4 26 14 46 34 58 M22 60 L36 59 L34 45", K.white, 6)}</svg>
    ${art("print", "sg-side-art")}
    <p class="sg-say">Your strip prints on the party printer!</p>
  </div>
</section>
<ol class="sg-steps three">
  ${step(1, "Scan", "Point your <b>Camera</b> at the code. Tap the link.", "scan")}
  ${step(2, "Allow", "Tap <b>Allow</b> so the booth can use your camera.", "allow")}
  ${step(3, "Snap!", "Tap the <b>camera</b>, then the <b>printer</b>. Grab your strip!", "shutter")}
</ol>
<div class="sg-foot"><span class="sg-tip"><b>Keep it:</b> Share, then <b>Add to Home Screen</b></span>
  <span class="sg-tip"><b>iPhone app?</b> Scan the other sign</span><span class="sg-url">${esc(host)}</span></div>`);
}

/** The party album sign: scan for every photo from the party. */
export function albumSignHTML({ name, date, url }) {
  return page("album", confetti([
    ["spark", .35, .35, K.sky, 1], ["dot", 7.0, .3, K.pink, 1], ["spark", 7.15, 1.5, K.sun, .8], ["dot", .3, 1.75, K.mint, 1],
    ["squig", 6.3, .55, K.grape, 1], ["spark", 1.2, .15, K.pink, .6],
    ["dot", .2, 9.7, K.sun, .8], ["spark", 7.1, 9.62, K.pink, .75], ["squig", 4.9, 9.74, K.mint, .9],
  ]) + `
<div class="sg-head">${title(name, K.sun)}
  ${date ? `<div class="sg-pill date">${esc(date)}</div>` : ""}</div>
<section class="sg-mid">
  ${qrBlock(url, "Scan for your photos")}
  <div class="sg-side">
    ${art("sharePhoto", "sg-side-art")}
    <p class="sg-say">See, save &amp; share every photo from the party</p>
    ${art("party", "sg-side-art")}
    <p class="sg-say">Each printed strip has its own code too</p>
  </div>
</section>
<ol class="sg-steps three">
  ${step(1, "Pose", "Strike a pose at the <b>photo booth</b>.", "shutter")}
  ${step(2, "Print", "Out pops a real <b>receipt strip</b>. Keep it!", "print")}
  ${step(3, "Scan", "Point your <b>Camera</b> at this code for the whole album.", "scan")}
</ol>`);
}

/** Tighten each title's viewBox to its real text box (call after the display font has loaded). */
export function fitSignTitles(root) {
  for (const svg of root.querySelectorAll(".sg-title svg")) {
    const b = svg.getBBox();
    if (b.width > 0) svg.setAttribute("viewBox", `${f1(b.x - 4)} ${f1(b.y - 6)} ${f1(b.width + 12)} ${f1(b.height + 14)}`);
  }
}
