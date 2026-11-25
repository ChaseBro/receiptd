// Drawn icons ("Thermal Arcade" stickers): thick ink outline, hard offset shadow, a little tilt,
// candy fills, Lilita numerals. One inline-SVG module for every page; iOS mirrors the geometry
// in ios/App/Icons.swift (same 100×100 viewBox, same numbers). Source of truth: the approved
// booth sketch (ios/build/sketch/booth-sketch.html). Pure strings, no DOM at import, so it runs
// under node --test.
//
// Settings → Icon style: "drawn" (default) or "classic" (the emoji the booth used before).
// Theme-picker icons stay emoji either way.

// The DESIGN.md token values (index.html :root). Icons paint with these only (lint-checked).
export const K = { ink: "#1A1423", paper: "#FFF4DC", white: "#FFFFFF", pink: "#FF5DA2", sun: "#FFD23F", mint: "#2EE6A6", sky: "#3EC1FF", grape: "#9B6BFF", tomato: "#FF6B4A" };

const st = (w = 6) => `stroke="${K.ink}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"`;
/** "Outlined stroke": a fat ink line under a thinner colour line. */
const ol = (d, c, w = 10) => `<path d="${d}" fill="none" stroke="${K.ink}" stroke-width="${w + 11}" stroke-linecap="round" stroke-linejoin="round"/>` +
                             `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const rad = (a) => (a * Math.PI) / 180;
const pt = (cx, cy, r, a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
const f1 = (v) => v.toFixed(1);

/** An arc with an outlined arrowhead at its end (degrees; clockwise when a1 > a0). */
function arcArrow(cx, cy, r, a0, a1, c, w = 10, hs = 1) {
  const [x0, y0] = pt(cx, cy, r, a0), [x1, y1] = pt(cx, cy, r, a1);
  const sweep = a1 > a0 ? 1 : 0, large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const d = `M${f1(x0)} ${f1(y0)} A${r} ${r} 0 ${large} ${sweep} ${f1(x1)} ${f1(y1)}`;
  const dir = a1 + (sweep ? 90 : -90), ux = Math.cos(rad(dir)), uy = Math.sin(rad(dir)), nx = -uy, ny = ux;
  const L = 13 * hs, W = 12 * hs;
  const tip = [x1 + ux * L, y1 + uy * L], b1 = [x1 - ux * 3 + nx * W, y1 - uy * 3 + ny * W], b2 = [x1 - ux * 3 - nx * W, y1 - uy * 3 - ny * W];
  const head = `<polygon points="${[tip, b1, b2].map((p) => p.map(f1).join(",")).join(" ")}" fill="${c}" ${st(5.5)}/>`;
  return `<path d="${d}" fill="none" stroke="${K.ink}" stroke-width="${w + 11}" stroke-linecap="round"/>` + head +
         `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
}
function starPts(cx, cy, ro, ri, n, rot = 0) {
  const p = [];
  for (let i = 0; i < 2 * n; i++) { const [x, y] = pt(cx, cy, i % 2 ? ri : ro, rot + (180 * i) / n - 90); p.push(f1(x) + "," + f1(y)); }
  return p.join(" ");
}
const spark = (x, y, s = 1, c = K.sun) => `<polygon points="${starPts(x, y, 10 * s, 4.2 * s, 4)}" fill="${c}" ${st(3.5)}/>`;
const bang = (x, y, c = K.sun) => `<circle cx="${x}" cy="${y}" r="12" fill="${c}" ${st(4.5)}/><path d="M${x} ${y - 6} V${y + 1}" ${st(5)}/><circle cx="${x}" cy="${y + 6}" r="2.6" fill="${K.ink}"/>`;
const numBadge = (x, y, n, c = K.sun, r = 13) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}" ${st(4.5)}/><text x="${x}" y="${y + r * 0.52}" text-anchor="middle" font-family="Lilita, Arial Rounded MT Bold, sans-serif" font-size="${r * 1.55}" fill="${K.ink}">${n}</text>`;

function camera({ star = true, tilt = -6 } = {}) {
  return `<g transform="rotate(${tilt} 50 56)">
    <rect x="27" y="19" width="26" height="17" rx="5" fill="${K.pink}" ${st()}/>
    <rect x="12" y="30" width="76" height="56" rx="13" fill="${K.tomato}"/>
    <path d="M12 56 V43 A13 13 0 0 1 25 30 H75 A13 13 0 0 1 88 43 V56 Z" fill="${K.pink}"/>
    <path d="M12 56 H88" ${st(4)}/>
    <rect x="12" y="30" width="76" height="56" rx="13" fill="none" ${st()}/>
    <circle cx="50" cy="58" r="21" fill="${K.white}" ${st()}/>
    <circle cx="50" cy="58" r="12.5" fill="${K.sky}" ${st(5)}/>
    <circle cx="46" cy="54" r="3.6" fill="${K.white}"/><circle cx="54.5" cy="62" r="1.8" fill="${K.white}"/>
  </g>` + (star ? `<polygon points="${starPts(82, 20, 15, 6.5, 8, 10)}" fill="${K.sun}" ${st(4)}/><circle cx="82" cy="20" r="4" fill="${K.white}"/>` : "");
}
function zigzag(x0, w, y1, teeth) {
  const tw = w / teeth; let zz = "";
  for (let i = 0; i < teeth; i++) zz += ` L${f1(x0 + w - tw * i - tw / 2)} ${y1 + 7} L${f1(x0 + w - tw * (i + 1))} ${y1}`;
  return zz;
}
function receiptShape(x0, y0, w, y1, fill = K.paper, teeth = 6) {
  return `<path d="M${x0} ${y0} H${x0 + w} V${y1}${zigzag(x0, w, y1, teeth)} Z" fill="${fill}" ${st()}/>`;
}
/** A photo frame (sky) with a little person, as on the strip. */
const frame = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${K.sky}" ${st(4)}/><circle cx="${x + w / 2}" cy="${y + h * 0.45}" r="${f1(h * 0.17)}" fill="${K.ink}"/><path d="M${f1(x + w / 2 - h * 0.32)} ${y + h - 1} Q${x + w / 2} ${y + h * 0.5} ${f1(x + w / 2 + h * 0.32)} ${y + h - 1}" fill="${K.ink}"/>`;
function strip(n) {
  const x0 = 28, w = 42;
  const y0 = n === 3 ? 8 : 22, y1 = n === 3 ? 84 : 72;
  let s = `<g transform="rotate(-5 50 50)"><path d="M${x0} ${y0} H${x0 + w} V${y1}${zigzag(x0, w, y1, 6)} Z" fill="${K.paper}" ${st()}/>`;
  if (n === 3) s += frame(x0 + 7, 15, w - 14, 18) + frame(x0 + 7, 38, w - 14, 18) + frame(x0 + 7, 61, w - 14, 18);
  else s += frame(x0 + 7, 30, w - 14, 32);
  return s + `</g>` + numBadge(76, 20, n, K.sun, 15);
}

// --- the printer: one drawing, many moods ---------------------------------------------------
function printer({ lid = "closed", paper = "none", face = "happy", led = K.mint, fill = K.white, lidFill = K.sky } = {}) {
  let s = "";
  if (paper === "strip") s += `<g transform="rotate(-4 50 30)">${receiptShape(31, 4, 38, 30, K.white, 5)}<rect x="38" y="8" width="24" height="15" rx="3" fill="${K.sky}" ${st(4)}/><circle cx="50" cy="14" r="3" fill="${K.ink}"/></g>`;
  if (paper === "tongue") s += `<rect x="34" y="20" width="32" height="16" fill="${K.white}" ${st(5)}/>`;
  if (lid === "open") {
    s += `<rect x="16" y="36" width="68" height="12" rx="4" fill="${K.ink}"/>`;
    s += `<circle cx="50" cy="40" r="13" fill="${K.white}" ${st(5)}/><circle cx="50" cy="40" r="4.5" fill="${K.paper}" ${st(3.5)}/>`;
  }
  s += `<rect x="12" y="42" width="76" height="44" rx="12" fill="${fill}" ${st()}/>`;
  if (lid === "closed") s += `<rect x="17" y="29" width="66" height="17" rx="7" fill="${lidFill}" ${st()}/>`;
  else s += `<g transform="rotate(-48 17 44)"><rect x="17" y="29" width="66" height="15" rx="7" fill="${lidFill}" ${st()}/></g>`;
  s += `<circle cx="77" cy="76" r="4.5" fill="${led}" ${st(3.5)}/>`;
  const E = { l: 36, r: 60, y: 62, m: 48 };
  const faces = {
    happy: `<path d="M${E.l - 5} ${E.y + 2} Q${E.l} ${E.y - 5} ${E.l + 5} ${E.y + 2} M${E.r - 5} ${E.y + 2} Q${E.r} ${E.y - 5} ${E.r + 5} ${E.y + 2}" fill="none" ${st(4.5)}/><path d="M${E.m - 7} ${E.y + 9} Q${E.m} ${E.y + 17} ${E.m + 7} ${E.y + 9} Z" fill="${K.ink}" ${st(3)}/>`,
    sleep: `<path d="M${E.l - 5} ${E.y} Q${E.l} ${E.y + 4} ${E.l + 5} ${E.y} M${E.r - 5} ${E.y} Q${E.r} ${E.y + 4} ${E.r + 5} ${E.y}" fill="none" ${st(4.5)}/><circle cx="${E.m}" cy="${E.y + 12}" r="3" fill="${K.ink}"/>`,
    worried: `<circle cx="${E.l}" cy="${E.y + 1}" r="3.4" fill="${K.ink}"/><circle cx="${E.r}" cy="${E.y + 1}" r="3.4" fill="${K.ink}"/><path d="M${E.l - 6} ${E.y - 8} L${E.l + 4} ${E.y - 5} M${E.r + 6} ${E.y - 8} L${E.r - 4} ${E.y - 5}" ${st(4)}/><path d="M${E.m - 7} ${E.y + 14} Q${E.m} ${E.y + 8} ${E.m + 7} ${E.y + 14}" fill="none" ${st(4.5)}/>`,
    oh: `<circle cx="${E.l}" cy="${E.y}" r="3.6" fill="${K.ink}"/><circle cx="${E.r}" cy="${E.y}" r="3.6" fill="${K.ink}"/><ellipse cx="${E.m}" cy="${E.y + 12}" rx="4" ry="5" fill="${K.ink}"/>`,
    x: `<path d="M${E.l - 5} ${E.y - 5} L${E.l + 5} ${E.y + 5} M${E.l + 5} ${E.y - 5} L${E.l - 5} ${E.y + 5} M${E.r - 5} ${E.y - 5} L${E.r + 5} ${E.y + 5} M${E.r + 5} ${E.y - 5} L${E.r - 5} ${E.y + 5}" ${st(4.5)}/><path d="M${E.m - 9} ${E.y + 13} q3 -4 6 0 t6 0 t6 0" fill="none" ${st(4)}/>`,
  };
  return s + (faces[face] || "");
}
const scaleG = (inner, s, tx, ty) => `<g transform="translate(${tx} ${ty}) scale(${s})">${inner}</g>`;
const zz = (x, y, s) => {
  const d = `M${x} ${y} h${7 * s} l${-7 * s} ${8 * s} h${7 * s}`;
  return `<path d="${d}" fill="none" stroke="${K.ink}" stroke-width="${8 * s + 4}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${K.grape}" stroke-width="${4.5 * s}" stroke-linecap="round" stroke-linejoin="round"/>`;
};
function gearPts(cx, cy, ro, ri, n) {
  const p = [], tw = 360 / n;
  for (let i = 0; i < n; i++) {
    const a = i * tw - 90;
    for (const [ang, r] of [[a - tw * 0.5, ri], [a - tw * 0.2, ri], [a - tw * 0.13, ro], [a + tw * 0.13, ro], [a + tw * 0.2, ri]]) { const [x, y] = pt(cx, cy, r, ang); p.push(f1(x) + "," + f1(y)); }
  }
  return p.join(" ");
}
function hourglass() {
  return `<g transform="rotate(8 50 50)">
    <path d="M30 22 C30 42 45 45 45 50 C45 55 30 58 30 78 H70 C70 58 55 55 55 50 C55 45 70 42 70 22 Z" fill="${K.white}" ${st()}/>
    <path d="M37 33 H63 C60 40 52 44 50 47 C48 44 40 40 37 33 Z" fill="${K.sun}"/>
    <path d="M50 49 V66" stroke="${K.sun}" stroke-width="3.5" stroke-linecap="round"/>
    <path d="M35 76 Q50 60 65 76 Z" fill="${K.sun}"/>
    <path d="M30 22 C30 42 45 45 45 50 C45 55 30 58 30 78 H70 C70 58 55 55 55 50 C55 45 70 42 70 22 Z" fill="none" ${st()}/>
    <rect x="22" y="11" width="56" height="11" rx="5" fill="${K.grape}" ${st()}/>
    <rect x="22" y="78" width="56" height="11" rx="5" fill="${K.grape}" ${st()}/></g>`;
}
function photoCard(tilt = -10) {
  return `<g transform="rotate(${tilt} 50 58)"><rect x="27" y="32" width="46" height="52" rx="5" fill="${K.white}" ${st()}/>
    <rect x="33" y="38" width="34" height="30" rx="3" fill="${K.sky}" ${st(4)}/><circle cx="50" cy="50" r="5" fill="${K.ink}"/><path d="M40 67 Q50 53 60 67" fill="${K.ink}"/></g>`;
}
const PRINTER_S = 0.8;

/** name → SVG body (in a 0 0 100 100 box). `queue` takes the place-in-line number. */
export const DRAWN = {
  shutter: () => camera(),
  flip: () => scaleG(camera({ star: false, tilt: 0 }), 0.54, 23, 21) + arcArrow(50, 52, 40, 200, 290, K.sun, 9, 0.85) + arcArrow(50, 52, 40, 20, 110, K.sun, 9, 0.85),
  one: () => strip(1),
  three: () => strip(3),
  nocam: () => scaleG(camera({ star: false, tilt: -6 }), 0.9, 5, 2) + ol("M16 16 L84 84", K.tomato, 10),
  gear: () => `<g transform="rotate(10 50 50)"><polygon points="${gearPts(50, 50, 41, 30, 8)}" fill="${K.grape}" ${st()}/><circle cx="50" cy="50" r="12" fill="${K.white}" ${st()}/></g>`,
  // Make another booth (hosts): a phone with a + badge. Restyled from the old line icon to the set.
  makeBooth: () => `<g transform="rotate(-6 50 50)"><rect x="22" y="8" width="44" height="80" rx="10" fill="${K.white}" ${st()}/>
      <rect x="29" y="20" width="30" height="50" rx="4" fill="${K.sky}" ${st(4)}/><path d="M38 14 H50" ${st(4.5)}/><circle cx="44" cy="79" r="3.5" fill="${K.ink}"/></g>
      <circle cx="72" cy="70" r="20" fill="${K.mint}" ${st()}/>` + ol("M72 60 V80 M62 70 H82", K.white, 6),
  // Share this photo (kids): the strip with an arrow leaving it. Restyled to the set.
  sharePhoto: () => `<g transform="rotate(-6 50 50)">${receiptShape(14, 8, 40, 82)}${frame(20, 15, 28, 18)}${frame(20, 38, 28, 18)}${frame(20, 61, 28, 16)}</g>` +
      ol("M48 58 L80 26 M60 22 H84 V46", K.white, 8),
  wait: () => hourglass(),
  queue: (n = 2) => hourglass() + numBadge(78, 78, n, K.sky, 15),
  retake: () => ol("M30 30 L70 70 M70 30 L30 70", K.white, 13),
  print: () => printer({ paper: "strip", face: "happy" }) + spark(88, 14, 0.9) + spark(14, 22, 0.65, K.pink),
  rotate: () => photoCard(-8) + arcArrow(50, 58, 42, 205, 300, K.sun, 9, 0.9),
  receipt: () => `<g transform="rotate(-6 50 50)">${receiptShape(28, 10, 44, 80)}<path d="M36 24 H64 M36 36 H58 M36 48 H64 M36 60 H52" ${st(4.5)}/></g>`,
  minus: () => ol("M27 50 H73", K.white, 13),
  plus: () => ol("M27 50 H73 M50 27 V73", K.white, 13),
  again: () => arcArrow(50, 52, 28, -50, 235, K.sun, 11),
  back: () => ol("M72 50 H30 M47 32 L29 50 L47 68", K.white, 13),
  done: () => `<g transform="rotate(-6 50 50)">${receiptShape(20, 8, 42, 80, K.paper, 6)}
      <rect x="27" y="16" width="28" height="20" rx="3" fill="${K.sky}" ${st(4)}/><rect x="27" y="44" width="28" height="20" rx="3" fill="${K.sky}" ${st(4)}/></g>
      <circle cx="68" cy="66" r="21" fill="${K.mint}" ${st()}/>` + ol("M58 66 L66 74 L79 58", K.white, 7) + spark(84, 18, 1) + spark(12, 88, 0.7, K.pink),
  // Printer states: the same printer with a face; the thing that changed is drawn in.
  pReady: () => printer({ paper: "tongue", face: "happy" }),
  pPrinting: () => printer({ paper: "strip", face: "happy" }) + `<path d="M22 12 H14 M22 22 H10 M78 12 H86 M78 22 H90" ${st(4.5)}/>`,
  // Offline, simplified so it reads at 44 px: sleeping printer, one bold cable, a big plug pulled
  // out of a big wall socket, one zZ. (The sketch's version had extra motion marks and a second Z.)
  pOffline: () => scaleG(printer({ face: "sleep", led: K.paper }), 0.74, -2, -10) +
      `<path d="M60 48 C84 46 88 62 76 74" fill="none" stroke="${K.ink}" stroke-width="9" stroke-linecap="round"/>
       <rect x="58" y="72" width="28" height="22" rx="6" fill="${K.grape}" ${st(5)}/><path d="M58 78 H48 M58 88 H48" ${st(6)}/>
       <rect x="6" y="68" width="30" height="28" rx="7" fill="${K.white}" ${st(5)}/><rect x="14" y="76" width="4.5" height="11" rx="1.5" fill="${K.ink}"/><rect x="24" y="76" width="4.5" height="11" rx="1.5" fill="${K.ink}"/>` + zz(74, 2, 1.25),
  pPaperOut: () => scaleG(printer({ face: "worried", led: K.sun }), PRINTER_S, -2, 14) +
      `<circle cx="74" cy="24" r="18" fill="${K.white}" stroke="${K.ink}" stroke-width="4" stroke-dasharray="6 5"/>
       <circle cx="74" cy="24" r="8" fill="${K.sun}" ${st(4.5)}/><circle cx="74" cy="24" r="3" fill="${K.ink}"/>` + bang(88, 84),
  pPaperLow: () => scaleG(printer({ face: "oh", led: K.sun }), PRINTER_S, -2, 14) +
      `<circle cx="74" cy="24" r="12" fill="${K.white}" ${st(4.5)}/><circle cx="74" cy="24" r="8" fill="${K.sun}" ${st(4)}/><circle cx="74" cy="24" r="3" fill="${K.ink}"/>`,
  pCover: () => printer({ lid: "open", face: "oh", led: K.sun }) + `<path d="M76 10 q6 4 6 12 M86 6 q8 6 8 18" fill="none" ${st(4.5)}/>` + bang(88, 92),
  pError: () => printer({ face: "x", led: K.tomato }) +
      `<g fill="${K.white}" ${st(4.5)}><circle cx="34" cy="16" r="8"/><circle cx="46" cy="10" r="9"/><circle cx="56" cy="17" r="7"/></g>` +
      `<polygon points="70,4 62,20 70,20 64,32 80,14 72,14 78,4" fill="${K.sun}" ${st(4)}/>` + bang(88, 92, K.tomato),
  paperOk: () => `<circle cx="50" cy="50" r="32" fill="${K.white}" ${st()}/><circle cx="50" cy="50" r="12" fill="${K.sun}" ${st(5)}/><circle cx="50" cy="50" r="4" fill="${K.ink}"/><path d="M50 82 H86 V70" fill="none" ${st()}/>`,
  upload: () => `<path d="M24 72 Q10 72 12 58 Q14 46 28 47 Q30 28 50 28 Q68 28 72 44 Q90 42 90 58 Q90 72 76 72 Z" fill="${K.white}" ${st()}/>` + ol("M50 76 V48 M40 58 L50 47 L60 58", K.sky, 8),
  party: () => `<polygon points="20,84 40,24 78,62" fill="${K.pink}" ${st()}/><path d="M30 54 L58 72 M35 39 L68 62" stroke="${K.sun}" stroke-width="6"/><polygon points="20,84 40,24 78,62" fill="none" ${st()}/>` + spark(70, 22, 1) + spark(88, 46, 0.6, K.sky) + `<circle cx="54" cy="12" r="5" fill="${K.mint}" ${st(3.5)}/>`,
};

// Classic: today's emoji (and the two small line icons the booth already had).
const OLD_PHONE = `<svg class="ico" viewBox="0 0 48 48" aria-hidden="true"><rect class="paper" x="9" y="3" width="24" height="41" rx="5"/><rect class="inkf" x="17" y="7" width="8" height="3" rx="1.5"/><circle class="inkf" cx="21" cy="39" r="2"/><circle class="plus" cx="35" cy="33" r="10"/><path class="plusbar" d="M35 27.5 V38.5 M29.5 33 H40.5"/></svg>`;
const OLD_STRIP = `<svg class="ico" viewBox="0 0 48 48" aria-hidden="true"><rect class="paper" x="6" y="3" width="21" height="42" rx="3"/><rect class="inkf" x="10.5" y="8" width="12" height="8.5" rx="1.5"/><rect class="inkf" x="10.5" y="19.75" width="12" height="8.5" rx="1.5"/><rect class="inkf" x="10.5" y="31.5" width="12" height="8.5" rx="1.5"/><path class="halo" d="M22 28 L41 9 M30 8 H42 V20"/><path class="arrow" d="M22 28 L41 9 M30 8 H42 V20"/></svg>`;
export const CLASSIC = {
  shutter: "📸", flip: "🔄", nocam: "🙈", gear: "⚙️", wait: "⏳", retake: "✖️", print: "🖨️", rotate: "↻", receipt: "🧾",
  minus: "➖", plus: "➕", again: "🔁", back: "✖️", queue: "⏳", done: "🎉", upload: "☁️", party: "🎉", paperOk: "🧻",
  pReady: "😺", pPrinting: "😺", pOffline: "🔌", pPaperOut: "🧻", pPaperLow: "🧻", pCover: "🖨️", pError: "💥",
};
const CLASSIC_HTML = {
  one: `<span class="strip-ico one"><b></b></span>`,
  three: `<span class="strip-ico"><b></b><b></b><b></b></span>`,
  makeBooth: OLD_PHONE,
  sharePhoto: OLD_STRIP,
};
export const ICON_NAMES = Object.keys(DRAWN);

/** The shared hard-shadow filter (offset ink copy of the alpha, no blur). Put once in the page. */
export const ICON_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>` +
  `<filter id="ic-hs" filterUnits="userSpaceOnUse" x="-30" y="-30" width="170" height="170" color-interpolation-filters="sRGB">` +
  `<feFlood flood-color="${K.ink}" result="f"/><feComposite in="f" in2="SourceAlpha" operator="in" result="a"/>` +
  `<feOffset in="a" dx="4" dy="4" result="s"/><feMerge><feMergeNode in="s"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs></svg>`;

/** One icon as an inline SVG (decorative: the button carries the aria-label). */
export function drawnSVG(name, arg) {
  const draw = DRAWN[name];
  if (!draw) throw new Error("no icon " + name);
  return `<svg class="ic" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><g filter="url(#ic-hs)">${draw(arg)}</g></svg>`;
}
/** Markup for an icon slot in the chosen style ("drawn" | "classic"). */
export function iconHTML(name, style = "drawn", arg) {
  if (style !== "classic") return drawnSVG(name, arg);
  if (CLASSIC_HTML[name]) return CLASSIC_HTML[name];
  const e = CLASSIC[name] ?? "";
  return `<span class="emoji" aria-hidden="true">${e}</span>`;
}

/** Fill every [data-ic] slot under `root` (data-ic-arg: optional number, e.g. place in line). */
export function paintIcons(root, style = "drawn") {
  if (!root.getElementById?.("ic-defs") && !root.ownerDocument?.getElementById("ic-defs")) {
    const doc = root.ownerDocument ?? root, holder = doc.createElement("div");
    holder.id = "ic-defs"; holder.innerHTML = ICON_DEFS; doc.body.prepend(holder);
  }
  for (const el of root.querySelectorAll("[data-ic]")) {
    const key = `${style}|${el.dataset.ic}|${el.dataset.icArg ?? ""}`;
    if (el.dataset.icPainted === key) continue;
    el.dataset.icPainted = key;
    el.innerHTML = iconHTML(el.dataset.ic, style, el.dataset.icArg ? +el.dataset.icArg : undefined);
  }
}
