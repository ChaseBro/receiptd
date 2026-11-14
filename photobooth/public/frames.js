// Strip layouts + print art ("Thermal Arcade", see ../DESIGN.md).
// Print art is ink only: pure #000 / #fff shapes (and emoji stickers).
// Photos arrive tone-mapped; the whole strip is dithered afterwards, and
// solid black/white art survives dithering untouched.

import { PRINT_WIDTH as W, luminance, toneMap } from "./raster.js";

const INK = "#000", PAPER = "#fff";
const DISPLAY = `"Lilita", "Arial Rounded MT Bold", sans-serif`;
const EMOJI = `"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;

// Seeded PRNG so re-composing (e.g. after rotating a photo) keeps placement.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---- primitives -----------------------------------------------------------

function star(ctx, cx, cy, r, points = 5, inner = 0.45, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (Math.PI * i) / points - Math.PI / 2 + rot;
    const rr = i % 2 ? r * inner : r;
    ctx.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
  }
  ctx.closePath();
}

function heart(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.9);
  ctx.bezierCurveTo(cx - s * 1.4, cy - s * 0.1, cx - s * 0.6, cy - s * 1.1, cx, cy - s * 0.35);
  ctx.bezierCurveTo(cx + s * 0.6, cy - s * 1.1, cx + s * 1.4, cy - s * 0.1, cx, cy + s * 0.9);
  ctx.closePath();
}

/** Current path as a sticker: white halo, then black fill or outlined white. */
function stamp(ctx, draw, { fill = true, halo = 5, line = 4 } = {}) {
  ctx.save();
  draw();
  ctx.lineJoin = "round";
  if (halo) { ctx.strokeStyle = PAPER; ctx.lineWidth = halo * 2 + line; ctx.stroke(); }
  if (fill) { ctx.fillStyle = INK; ctx.fill(); }
  else { ctx.fillStyle = PAPER; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = line; ctx.stroke(); }
  ctx.restore();
}

/** Emoji die-cut sticker: thick white outline + hard black offset shadow. */
function sticker(ctx, emoji, x, y, size, angle = 0) {
  const S = Math.ceil(size * 1.7), o = Math.max(5, size * 0.09);
  const art = new OffscreenCanvas(S, S), a = art.getContext("2d");
  a.font = `${size}px ${EMOJI}`; a.textAlign = "center"; a.textBaseline = "middle";
  a.fillText(emoji, S / 2, S / 2);
  const sil = (color, grow) => {
    const c = new OffscreenCanvas(S, S), h = c.getContext("2d");
    for (let k = 0; k < 16; k++) { const t = (Math.PI * 2 * k) / 16; h.drawImage(art, Math.cos(t) * grow, Math.sin(t) * grow); }
    h.globalCompositeOperation = "source-in"; h.fillStyle = color; h.fillRect(0, 0, S, S);
    return c;
  };
  const halo = sil(PAPER, o), shadow = sil(INK, o + 3);
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.drawImage(shadow, -S / 2 + 6, -S / 2 + 6);
  ctx.drawImage(halo, -S / 2, -S / 2);
  ctx.drawImage(art, -S / 2, -S / 2);
  ctx.restore();
}

/** Black rays fanning out from (cx, cy), clipped to a box. */
function sunburst(ctx, cx, cy, box, n = 24, fill = 0.35) {
  ctx.save();
  ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.fillStyle = INK;
  const R = Math.hypot(box.w, box.h) * 1.2;
  for (let i = 0; i < n; i += 2) {
    const a0 = (Math.PI * 2 * i) / n, a1 = a0 + (Math.PI * 4 * fill) / n;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.cos(a0), cy + R * Math.sin(a0)); ctx.lineTo(cx + R * Math.cos(a1), cy + R * Math.sin(a1));
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

/** Halftone dots whose radius follows f(u, v) in 0..1 over the box. */
function halftone(ctx, box, f, step = 12) {
  ctx.save(); ctx.fillStyle = INK;
  for (let y = box.y + step / 2, row = 0; y < box.y + box.h; y += step, row++) {
    for (let x = box.x + (row % 2 ? step / 2 : 0); x < box.x + box.w; x += step) {
      const r = (step / 2) * Math.sqrt(Math.max(0, Math.min(1, f((x - box.x) / box.w, (y - box.y) / box.h))));
      if (r > 0.6) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  ctx.restore();
}

/** Torn-paper zig-zag: black teeth hanging from y (dir 1) or rising to y (dir -1). */
function zigzag(ctx, y, dir = 1, tooth = 18, depth = 12) {
  ctx.save(); ctx.fillStyle = INK; ctx.beginPath(); ctx.moveTo(0, y);
  for (let x = 0; x <= W; x += tooth) { ctx.lineTo(x + tooth / 2, y + dir * depth); ctx.lineTo(x + tooth, y); }
  ctx.lineTo(W, y - dir * 4); ctx.lineTo(0, y - dir * 4); ctx.closePath(); ctx.fill(); ctx.restore();
}

function checker(ctx, y, rows = 2, sq = 16) {
  ctx.save(); ctx.fillStyle = INK;
  for (let r = 0; r < rows; r++) for (let x = 0; x < W; x += sq) if ((x / sq + r) % 2 === 0) ctx.fillRect(x, y + r * sq, sq, sq);
  ctx.restore();
}

function footprint(ctx, x, y, s, angle) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.fillStyle = INK;
  ctx.beginPath(); ctx.ellipse(0, 0, s * 0.55, s * 0.7, 0, 0, Math.PI * 2); ctx.fill();
  for (const dx of [-0.55, 0, 0.55]) { ctx.beginPath(); ctx.ellipse(dx * s, -s * 1.0, s * 0.18, s * 0.32, dx * 0.6, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

function scatter(rand, n, boxes, fn) {
  for (let i = 0; i < n; i++) {
    const b = boxes[Math.floor(rand() * boxes.length)];
    fn(b.x + rand() * b.w, b.y + rand() * b.h, rand);
  }
}

/** Free paper around the photos (for confetti/stars). */
function margins(L) {
  const boxes = [];
  for (const p of L.photos) {
    boxes.push({ x: 6, y: p.y, w: p.x - 16, h: p.h });
    boxes.push({ x: p.x + p.w + 16, y: p.y, w: W - p.x - p.w - 22, h: p.h });
  }
  return boxes.filter((b) => b.w > 8 && b.h > 8);
}

// ---- themes ---------------------------------------------------------------
// icon: kid picker; margin/top/gap: layout; bg() under photos; fg() on top.

export const THEMES = {
  film: {
    icon: "🎞️", margin: 52, top: 52, gap: 42,
    bg(ctx, L) {
      ctx.fillStyle = INK;
      ctx.fillRect(0, 0, 38, L.stubY); ctx.fillRect(W - 38, 0, 38, L.stubY);
      ctx.fillStyle = PAPER;
      for (let y = 14; y < L.stubY - 24; y += 38) {
        ctx.beginPath(); ctx.roundRect(10, y, 18, 24, 5); ctx.roundRect(W - 28, y, 18, 24, 5); ctx.fill();
      }
    },
    fg(ctx, L) {
      ctx.save(); ctx.fillStyle = INK; ctx.font = `22px ${DISPLAY}`; ctx.textAlign = "center";
      L.photos.forEach((p, i) => {
        ctx.save(); ctx.translate(W / 2, p.y - 8); ctx.fillText(`▸ ${String(i + 1).padStart(2, "0")}A`, 0, 0); ctx.restore();
      });
      ctx.restore();
    },
  },

  stars: {
    icon: "⭐", margin: 48, top: 168, gap: 36,
    bg(ctx, L) {
      sunburst(ctx, W / 2, 96, { x: 0, y: 0, w: W, h: 150 }, 28);
      ctx.save(); ctx.fillStyle = PAPER; ctx.beginPath(); ctx.arc(W / 2, 96, 74, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    },
    fg(ctx, L, rand) {
      stamp(ctx, () => star(ctx, W / 2, 96, 62), { halo: 0, fill: true });
      stamp(ctx, () => star(ctx, W / 2, 100, 26), { halo: 0, fill: false, line: 5 });
      for (const p of L.photos) {
        const [cx, cy] = rand() < 0.5 ? [p.x + 4, p.y + 4] : [p.x + p.w - 4, p.y + p.h - 4];
        stamp(ctx, () => star(ctx, cx, cy, 30 + rand() * 12, 5, 0.45, rand()), { fill: rand() < 0.5 });
      }
      scatter(rand, 30, margins(L), (x, y, r) =>
        stamp(ctx, () => star(ctx, x, y, 5 + r() * 8, r() < 0.3 ? 4 : 5, 0.42, r()), { halo: 0, fill: r() < 0.7, line: 2 }));
    },
  },

  hearts: {
    icon: "💖", margin: 48, top: 150, gap: 36,
    bg(ctx) {
      ctx.save(); ctx.fillStyle = INK;
      for (let x = 0; x < W + 36; x += 36) { ctx.beginPath(); ctx.arc(x, 18, 18, 0, Math.PI); ctx.fill(); }
      ctx.restore();
      halftone(ctx, { x: 0, y: 30, w: W, h: 100 }, (u, v) => 0.5 * (1 - v) * (0.6 + 0.4 * Math.sin(u * 12)), 11);
    },
    fg(ctx, L, rand) {
      stamp(ctx, () => heart(ctx, W / 2, 84, 52), { fill: true, halo: 8 });
      stamp(ctx, () => heart(ctx, W / 2 - 120, 92, 28), { fill: false, halo: 6 });
      stamp(ctx, () => heart(ctx, W / 2 + 120, 92, 28), { fill: false, halo: 6 });
      for (const p of L.photos) stamp(ctx, () => heart(ctx, p.x + p.w - 12, p.y + 14, 26 + rand() * 10));
      scatter(rand, 24, margins(L), (x, y, r) => stamp(ctx, () => heart(ctx, x, y, 5 + r() * 7), { halo: 0, fill: r() < 0.6, line: 2 }));
    },
  },

  party: {
    icon: "🎉", margin: 48, top: 160, gap: 36,
    bg(ctx) {
      halftone(ctx, { x: 0, y: 70, w: W, h: 80 }, (u, v) => 0.55 * (1 - v), 10);
    },
    fg(ctx, L, rand) {
      ctx.save(); ctx.strokeStyle = INK; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(0, 26); ctx.quadraticCurveTo(W / 2, 92, W, 26); ctx.stroke();
      for (let i = 0; i < 9; i++) {
        const t = (i + 0.5) / 9, x = t * W, y = (1 - t) * (1 - t) * 26 + 2 * (1 - t) * t * 92 + t * t * 26;
        ctx.beginPath(); ctx.moveTo(x - 26, y); ctx.lineTo(x + 26, y); ctx.lineTo(x, y + 58); ctx.closePath();
        ctx.fillStyle = i % 2 ? PAPER : INK; ctx.fill(); ctx.stroke();
        if (i % 2) { ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(x, y + 18, 7, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.restore();
      scatter(rand, 70, margins(L), (x, y, r) => {
        ctx.save(); ctx.translate(x, y); ctx.rotate(r() * Math.PI); ctx.fillStyle = INK; ctx.strokeStyle = INK; ctx.lineWidth = 3;
        const k = r();
        if (k < 0.35) ctx.fillRect(-8, -3, 16, 6);
        else if (k < 0.6) { ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, Math.PI * 2); ctx.fill(); }
        else if (k < 0.8) { ctx.beginPath(); ctx.moveTo(-9, 0); ctx.quadraticCurveTo(-4, -8, 0, 0); ctx.quadraticCurveTo(4, 8, 9, 0); ctx.stroke(); }
        else { ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(6, 5); ctx.lineTo(-6, 5); ctx.closePath(); ctx.fill(); }
        ctx.restore();
      });
      L.photos.forEach((p, i) => sticker(ctx, ["🎈", "🥳", "🎂", "🎁"][i % 4], i % 2 ? p.x + 20 : p.x + p.w - 20, p.y + p.h - 16, 74, (rand() - 0.5) * 0.6));
    },
  },

  dino: {
    icon: "🦖", margin: 44, top: 150, gap: 40,
    bg(ctx, L, rand) {
      // A trail of stomps wandering down the margins.
      for (let y = 30, i = 0; y < L.stubY - 40; y += 54, i++) {
        footprint(ctx, i % 2 ? 22 : 30, y, 9, -0.2 + rand() * 0.4);
        footprint(ctx, i % 2 ? W - 30 : W - 22, y + 27, 9, -0.2 + rand() * 0.4);
      }
    },
    fg(ctx, L, rand) {
      // Volcano silhouette + puffs.
      ctx.save(); ctx.fillStyle = INK;
      ctx.beginPath(); ctx.moveTo(W / 2 - 110, 136); ctx.lineTo(W / 2 - 30, 52); ctx.lineTo(W / 2 + 30, 52); ctx.lineTo(W / 2 + 110, 136); ctx.closePath(); ctx.fill();
      ctx.fillStyle = PAPER; ctx.strokeStyle = INK; ctx.lineWidth = 4;
      for (const [dx, dy, r] of [[-18, 36, 18], [8, 22, 22], [34, 8, 16]]) { ctx.beginPath(); ctx.arc(W / 2 + dx, dy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      ctx.restore();
      sticker(ctx, "🦕", 100, 92, 96, -0.12);
      sticker(ctx, "🦖", W - 100, 92, 96, 0.12);
      L.photos.forEach((p, i) => sticker(ctx, ["🦖", "🦕", "🥚", "🌋"][i % 4], i % 2 ? p.x + 26 : p.x + p.w - 26, p.y + p.h - 18, 70, (rand() - 0.5) * 0.5));
    },
  },

  space: {
    icon: "🚀", margin: 48, top: 160, gap: 36,
    bg(ctx, L, rand) {
      ctx.save(); ctx.fillStyle = INK;
      for (let i = 0; i < 220; i++) { const x = rand() * W, y = rand() * L.stubY; ctx.beginPath(); ctx.arc(x, y, 0.8 + rand() * 2.4, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.setLineDash([10, 9]);
      L.photos.forEach((p) => { ctx.beginPath(); ctx.ellipse(W / 2, p.y + p.h / 2, W / 2 - 8, p.h / 2 + 34, -0.18, 0, Math.PI * 2); ctx.stroke(); });
      ctx.restore();
    },
    fg(ctx, L, rand) {
      ctx.save(); ctx.translate(124, 86); ctx.rotate(-0.35);
      ctx.fillStyle = PAPER; ctx.strokeStyle = INK; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(0, 0, 46, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.arc(0, 0, 44, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = INK; for (let k = -40; k < 50; k += 16) ctx.fillRect(-50, k, 100, 6); ctx.restore();
      ctx.beginPath(); ctx.ellipse(0, 0, 82, 18, 0, 0.15 * Math.PI, 0.85 * Math.PI + Math.PI); ctx.lineWidth = 8; ctx.stroke();
      ctx.restore();
      stamp(ctx, () => star(ctx, W / 2 + 30, 64, 22, 4, 0.3), { halo: 0 });
      sticker(ctx, "🚀", W - 112, 84, 100, 0.65);
      L.photos.forEach((p, i) => sticker(ctx, ["👽", "🛸", "🌙", "🪐"][i % 4], p.x + p.w - 20, p.y + 20, 66, (rand() - 0.5) * 0.5));
    },
  },

  plain: {
    icon: "📷", margin: 40, top: 70, gap: 30,
    bg(ctx) { checker(ctx, 22, 2, 16); },
    fg() {},
  },
};

// ---- layout + compose -------------------------------------------------------

/** Clamp a photo's aspect to booth slots: landscape 4:3, portrait 4:5. */
const slotAspect = (w, h) => (w >= h ? 4 / 3 : 4 / 5);
const OFFSET = 10;          // black block behind each photo
const STUB = 150;           // ticket stub height (+ footer line)

export function layout(theme, frames, footer = "") {
  const t = THEMES[theme] ?? THEMES.plain;
  const pw = W - 2 * t.margin - OFFSET;
  let y = t.top;
  const photos = frames.map((f) => {
    const h = Math.round(pw / slotAspect(f.width, f.height));
    const r = { x: t.margin, y, w: pw, h };
    y += h + t.gap;
    return r;
  });
  const stubY = y - t.gap + 34;
  return { photos, stubY, H: stubY + STUB + (footer ? 40 : 0) };
}

/** Cover-crop + tone-map a frame into a w×h canvas. */
function photoTile(frame, w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const sa = frame.width / frame.height, da = w / h;
  let sw = frame.width, sh = frame.height;
  if (sa > da) sw = sh * da; else sh = sw / da;
  ctx.drawImage(frame, (frame.width - sw) / 2, (frame.height - sh) / 2, sw, sh, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const g = toneMap(luminance(img.data, w, h));
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = g[j]; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Perforated ticket stub: dashed tear line + date pill + big ticket number. */
function ticketStub(ctx, L, { ticket, date, footer }) {
  const y = L.stubY;
  ctx.save();
  ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.setLineDash([12, 10]);
  ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(W - 10, y); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = INK;
  ctx.font = `30px ${EMOJI}`; ctx.textBaseline = "middle"; ctx.fillText("✂", 0, y);
  // notches
  for (const x of [0, W]) { ctx.beginPath(); ctx.arc(x, y + 64, 18, 0, Math.PI * 2); ctx.fill(); }

  const d = date.toLocaleDateString(undefined, { day: "numeric", month: "short" }).toUpperCase();
  const tm = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).toUpperCase();
  ctx.textBaseline = "middle";
  // date pill (left)
  ctx.font = `34px ${DISPLAY}`;
  const label = `${d} · ${tm}`, tw = ctx.measureText(label).width + 40;
  ctx.beginPath(); ctx.roundRect(34, y + 38, tw, 52, 26); ctx.fill();
  ctx.fillStyle = PAPER; ctx.fillText(label, 54, y + 66);
  ctx.fillStyle = INK; ctx.font = `20px ${DISPLAY}`;
  ctx.fillText(String(date.getFullYear()), 54, y + 112);
  // ticket number (right), outlined with an offset shadow
  ctx.font = `76px ${DISPLAY}`; ctx.textAlign = "right";
  const num = `№${String(ticket).padStart(3, "0")}`;
  ctx.fillText(num, W - 22, y + 76);
  ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.fillStyle = PAPER;
  ctx.fillText(num, W - 28, y + 70); ctx.strokeText(num, W - 28, y + 70);
  if (footer) {
    ctx.fillStyle = INK; ctx.textAlign = "center"; ctx.font = `30px ${DISPLAY}`;
    ctx.fillText(footer, W / 2, y + 152, W - 60);
  }
  ctx.restore();
}

/**
 * Build the full grayscale strip. frames: canvases already rotated upright.
 * Returns { canvas, layout }.
 */
export function compose(frames, { theme = "stars", seed = 1, footer = "", ticket = 1, date = new Date() } = {}) {
  const t = THEMES[theme] ?? THEMES.plain;
  const L = layout(theme, frames, footer);
  const rand = rng(seed);
  const c = new OffscreenCanvas(W, L.H);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, L.H);

  t.bg?.(ctx, L, rand);

  L.photos.forEach((p, i) => {
    const tile = photoTile(frames[i], p.w, p.h);
    const tilt = ((rand() - 0.5) * 2 * (theme === "film" ? 0 : 1.6) * Math.PI) / 180;
    ctx.save();
    ctx.translate(p.x + p.w / 2, p.y + p.h / 2); ctx.rotate(tilt);
    ctx.fillStyle = INK; ctx.fillRect(-p.w / 2 + OFFSET, -p.h / 2 + OFFSET, p.w, p.h);      // hard shadow
    ctx.fillStyle = PAPER; ctx.fillRect(-p.w / 2 - 6, -p.h / 2 - 6, p.w + 12, p.h + 12);    // paper mat
    ctx.drawImage(tile, -p.w / 2, -p.h / 2);
    ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.strokeRect(-p.w / 2 - 3, -p.h / 2 - 3, p.w + 6, p.h + 6);
    ctx.restore();
  });

  t.fg(ctx, L, rand);
  zigzag(ctx, 0, 1, 18, 10);
  zigzag(ctx, L.H, -1, 18, 10);
  ticketStub(ctx, L, { ticket, date, footer });
  return { canvas: c, layout: L };
}

/** Calibration strip: one band per thermal gain, black block over greys. */
export function calibrationGray(gains) {
  const bandH = 300, H = bandH * gains.length + 40;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "middle";
  gains.forEach((g, i) => {
    const y = 20 + i * bandH;
    ctx.fillStyle = INK; ctx.font = `40px ${DISPLAY}`;
    ctx.fillText(String.fromCharCode(65 + i), 12, y + 50);
    // Black block on the left; the right side is the un-heated reference.
    ctx.fillRect(60, y, 320, 100);
    // Greys beneath, full width: 25%, 50%, then a ramp. (Calibration greys are
    // the one place print art isn't ink-only — they're the measurement.)
    ctx.fillStyle = "rgb(191,191,191)"; ctx.fillRect(60, y + 100, W - 80, 60); // lint-allow: calibration grey
    ctx.fillStyle = "rgb(128,128,128)"; ctx.fillRect(60, y + 160, W - 80, 60); // lint-allow: calibration grey
    const gr = ctx.createLinearGradient(60, 0, W - 20, 0);
    gr.addColorStop(0, PAPER); gr.addColorStop(1, INK);
    ctx.fillStyle = gr; ctx.fillRect(60, y + 220, W - 80, 40);
  });
  const img = ctx.getImageData(0, 0, W, H);
  return { gray: luminance(img.data, W, H), H, bandH };
}
