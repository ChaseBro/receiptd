// Strip layouts + print art ("Thermal Arcade", see ../DESIGN.md).
// Print art is ink only: pure #000 / #fff shapes (and emoji stickers).
// Photos arrive tone-mapped; the whole strip is dithered afterwards, and
// solid black/white art survives dithering untouched.

import { PRINT_WIDTH as W, luminance, toneMap } from "./raster.js";
import { drawQR, qrSide } from "./qr.js";

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

/** Maple leaf (stem down) as the current path: the classic 11-point outline. */
const MAPLE = [[0, -1], [0.13, -0.74], [0.32, -0.84], [0.27, -0.45], [0.58, -0.7], [0.55, -0.5], [0.92, -0.48],
  [0.75, -0.28], [0.82, -0.12], [0.45, -0.02], [0.52, 0.18], [0.1, 0.08], [0.05, 0.42], [0.03, 0.8]];
function maple(ctx, cx, cy, s, rot = 0) {
  const pts = [...MAPLE, ...MAPLE.slice().reverse().map(([x, y]) => [-x, y])];
  const c = Math.cos(rot), n = Math.sin(rot);
  ctx.beginPath();
  for (const [x, y] of pts) ctx.lineTo(cx + s * (x * c - y * n), cy + s * (x * n + y * c));
  ctx.closePath();
}

function acorn(ctx, x, y, s, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ctx.fillStyle = PAPER; ctx.strokeStyle = INK; ctx.lineWidth = Math.max(2, s * 0.14);
  ctx.beginPath(); ctx.ellipse(0, s * 0.25, s * 0.5, s * 0.62, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath(); ctx.ellipse(0, -s * 0.12, s * 0.62, s * 0.34, 0, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill();
  ctx.fillRect(-s * 0.07, -s * 0.72, s * 0.14, s * 0.3);
  ctx.restore();
}

/** One tail feather: outlined (or solid) teardrop with a quill and barbs. */
function feather(ctx, cx, cy, len, wid, angle, solid) {
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(angle);
  ctx.beginPath(); ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wid, len * 0.2, wid * 1.1, len * 0.8, 0, len);
  ctx.bezierCurveTo(-wid * 1.1, len * 0.8, -wid, len * 0.2, 0, 0);
  ctx.closePath();
  ctx.lineWidth = 4; ctx.strokeStyle = INK; ctx.fillStyle = solid ? INK : PAPER; ctx.fill(); ctx.stroke();
  ctx.strokeStyle = solid ? PAPER : INK; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(0, len * 0.12); ctx.lineTo(0, len * 0.92); ctx.stroke();
  ctx.lineWidth = 2;
  for (let k = 0.3; k < 0.9; k += 0.14) {
    ctx.beginPath(); ctx.moveTo(0, len * k); ctx.lineTo(wid * 0.55, len * (k + 0.07)); ctx.moveTo(0, len * k); ctx.lineTo(-wid * 0.55, len * (k + 0.07)); ctx.stroke();
  }
  ctx.restore();
}

/** Wheat stalk from (x, y) going up at `angle`: stem + paired kernels. */
function wheat(ctx, x, y, len, angle, k = 1) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
  ctx.strokeStyle = INK; ctx.fillStyle = INK; ctx.lineWidth = 3 * k;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const yy = -len * 0.45 - i * len * 0.09;
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.ellipse(side * 6 * k, yy, 4.5 * k, 9 * k, side * 0.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.beginPath(); ctx.ellipse(0, -len - 6 * k, 4 * k, 9 * k, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

/** Gingham: stripes every other row/column; crossings solid, single stripes hatched. */
function gingham(ctx, box, sq = 24) {
  ctx.save();
  ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  ctx.fillStyle = INK; ctx.strokeStyle = INK; ctx.lineWidth = 2.5;
  for (let j = 0; j * sq < box.h; j++) {
    for (let i = 0; i * sq < box.w; i++) {
      const x = box.x + i * sq, y = box.y + j * sq, a = i % 2 === 0, b = j % 2 === 0;
      if (a && b) ctx.fillRect(x, y, sq, sq);
      else if (a || b) {
        ctx.save(); ctx.beginPath(); ctx.rect(x, y, sq, sq); ctx.clip();
        ctx.beginPath();
        for (let d = -sq; d < sq * 2; d += 7) { ctx.moveTo(x + d, y); ctx.lineTo(x + d + sq, y + sq); }
        ctx.stroke(); ctx.restore();
      }
    }
  }
  ctx.restore();
}

function forkKnife(ctx, x, y, h) {
  ctx.save(); ctx.fillStyle = INK;
  // fork
  ctx.beginPath(); ctx.roundRect(x - 4, y + h * 0.35, 8, h * 0.65, 4); ctx.fill();
  ctx.beginPath(); ctx.roundRect(x - 13, y + h * 0.2, 26, h * 0.2, 6); ctx.fill();
  for (const dx of [-12, -4, 4]) ctx.fillRect(x + dx, y, 7, h * 0.3);
  // knife
  const kx = x + 40;
  ctx.beginPath(); ctx.roundRect(kx - 5, y + h * 0.45, 10, h * 0.55, 5); ctx.fill();
  ctx.beginPath(); ctx.moveTo(kx - 6, y + h * 0.48); ctx.lineTo(kx - 6, y + h * 0.05); ctx.quadraticCurveTo(kx + 10, y + h * 0.1, kx + 7, y + h * 0.48); ctx.closePath(); ctx.fill();
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

  // ---- Thanksgiving ----

  turkey: {
    icon: "🦃", margin: 48, top: 186, gap: 36,
    bg(ctx) {
      // Tail fan: 11 feathers, alternating solid / outlined, behind the body.
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, 172); ctx.clip();
      for (let i = 0; i < 11; i++) {
        const a = Math.PI / 2 + (Math.PI * (i - 5)) / 6.2;   // fan around straight up
        feather(ctx, W / 2, 150, 140, 30, a + Math.PI, i % 2 === 0);
      }
      ctx.restore();
    },
    fg(ctx, L, rand) {
      ctx.save(); ctx.fillStyle = PAPER; ctx.strokeStyle = INK; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(W / 2, 128, 46, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore();
      sticker(ctx, "🦃", W / 2, 120, 78, 0);
      L.photos.forEach((p, i) => sticker(ctx, ["🦃", "🥧", "🌽", "🍗"][i % 4], i % 2 ? p.x + 22 : p.x + p.w - 22, p.y + p.h - 16, 70, (rand() - 0.5) * 0.5));
      scatter(rand, 16, margins(L), (x, y, r) => {
        ctx.save(); ctx.translate(x, y); ctx.rotate(r() * Math.PI * 2); ctx.fillStyle = INK;
        ctx.beginPath(); ctx.ellipse(0, 0, 4, 11, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      });
    },
  },

  feast: {
    icon: "🥧", margin: 48, top: 176, gap: 36,
    bg(ctx) {
      gingham(ctx, { x: 0, y: 0, w: W, h: 150 }, 24);
    },
    fg(ctx, L, rand) {
      // Plate on the tablecloth, cutlery either side.
      ctx.save(); ctx.fillStyle = PAPER; ctx.strokeStyle = INK;
      ctx.lineWidth = 14; ctx.beginPath(); ctx.arc(W / 2, 82, 70, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 0; ctx.fill();
      ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(W / 2, 82, 64, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(W / 2, 82, 50, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      sticker(ctx, "🥧", W / 2, 82, 70, 0);
      for (const fx of [W / 2 - 160, W / 2 + 112]) {
        ctx.save(); ctx.fillStyle = PAPER; ctx.beginPath(); ctx.roundRect(fx - 24, 18, 88, 128, 16); ctx.fill(); ctx.restore();
        forkKnife(ctx, fx, 26, 112);
      }
      L.photos.forEach((p, i) => sticker(ctx, ["🍗", "🌽", "🥧", "🍠"][i % 4], i % 2 ? p.x + 22 : p.x + p.w - 22, p.y + p.h - 16, 72, (rand() - 0.5) * 0.5));
      scatter(rand, 26, margins(L), (x, y, r) => { ctx.save(); ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(x, y, 2 + r() * 3, 0, Math.PI * 2); ctx.fill(); ctx.restore(); });
    },
  },

  leaves: {
    icon: "🍂", margin: 48, top: 166, gap: 38,
    bg(ctx, L, rand) {
      // A twig across the top with leaves hanging off it.
      ctx.save(); ctx.strokeStyle = INK; ctx.lineCap = "round"; ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(-10, 34); ctx.bezierCurveTo(W * 0.3, 70, W * 0.6, 10, W + 10, 52); ctx.stroke();
      ctx.restore();
      for (let i = 0; i < 7; i++) {
        const x = 40 + i * ((W - 80) / 6), y = 74 + (i % 2) * 34;
        stamp(ctx, () => maple(ctx, x, y, 30 + rand() * 8, (rand() - 0.5) * 0.9), { fill: i % 2 === 0, halo: 4, line: 4 });
      }
    },
    fg(ctx, L, rand) {
      for (const p of L.photos) {
        const [cx, cy] = rand() < 0.5 ? [p.x + 8, p.y + 10] : [p.x + p.w - 8, p.y + p.h - 10];
        stamp(ctx, () => maple(ctx, cx, cy, 34 + rand() * 10, (rand() - 0.5) * 1.4), { fill: rand() < 0.6, halo: 6 });
      }
      scatter(rand, 26, margins(L), (x, y, r) => {
        if (r() < 0.25) acorn(ctx, x, y, 9 + r() * 4, (r() - 0.5));
        else stamp(ctx, () => maple(ctx, x, y, 7 + r() * 7, r() * 6), { halo: 0, fill: r() < 0.7, line: 2 });
      });
      L.photos.forEach((p, i) => sticker(ctx, ["🍁", "🐿️", "🍂", "🌰"][i % 4], i % 2 ? p.x + p.w - 22 : p.x + 22, p.y + p.h - 16, 66, (rand() - 0.5) * 0.5));
    },
  },

  starry: {
    icon: "🌟", margin: 48, top: 176, gap: 36,
    bg(ctx, L, rand) {
      // Night sky band with rolling hills along its bottom edge.
      ctx.save(); ctx.fillStyle = INK; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(W, 0); ctx.lineTo(W, 118);
      for (let x = W; x >= 0; x -= 8) ctx.lineTo(x, 132 + 12 * Math.sin(x / 70) + 6 * Math.sin(x / 23));
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = PAPER;
      for (let i = 0; i < 46; i++) { const x = rand() * W, y = 16 + rand() * 96; ctx.beginPath(); ctx.arc(x, y, 0.8 + rand() * 1.8, 0, Math.PI * 2); ctx.fill(); }
      for (let i = 0; i < 6; i++) { star(ctx, 30 + rand() * (W - 220), 24 + rand() * 80, 6 + rand() * 6, 5, 0.42, rand()); ctx.fill(); }
      // Harvest moon with craters.
      ctx.beginPath(); ctx.arc(W - 110, 66, 46, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 3;
      for (const [dx, dy, r] of [[-14, -12, 9], [16, 8, 12], [-8, 20, 6], [20, -20, 5]]) { ctx.beginPath(); ctx.arc(W - 110 + dx, 66 + dy, r, 0, Math.PI * 2); ctx.stroke(); }
      ctx.restore();
    },
    fg(ctx, L, rand) {
      sticker(ctx, "🦉", 96, 80, 72, -0.1);
      for (const p of L.photos) {
        const [cx, cy] = rand() < 0.5 ? [p.x + 4, p.y + 4] : [p.x + p.w - 4, p.y + p.h - 4];
        stamp(ctx, () => star(ctx, cx, cy, 28 + rand() * 12, 5, 0.45, rand()), { fill: rand() < 0.5 });
      }
      scatter(rand, 30, margins(L), (x, y, r) =>
        stamp(ctx, () => star(ctx, x, y, 4 + r() * 7, r() < 0.3 ? 4 : 5, 0.42, r()), { halo: 0, fill: r() < 0.7, line: 2 }));
      L.photos.forEach((p, i) => sticker(ctx, ["🦃", "🌟", "🥧", "🌙"][i % 4], i % 2 ? p.x + 22 : p.x + p.w - 22, p.y + p.h - 16, 64, (rand() - 0.5) * 0.5));
    },
  },

  harvest: {
    icon: "🌽", margin: 50, top: 176, gap: 36,
    bg(ctx) {
      halftone(ctx, { x: 0, y: 14, w: W, h: 140 }, (u, v) => 0.5 * (1 - v) * (0.4 + 0.6 * Math.abs(u - 0.5) * 2), 11);
    },
    fg(ctx, L, rand) {
      // Wheat sheaves either side of a big corn cob.
      for (const [x, dir] of [[96, 1], [W - 96, -1]]) {
        ctx.save(); ctx.fillStyle = PAPER; ctx.beginPath(); ctx.ellipse(x, 92, 70, 66, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
        for (const a of [-0.45, -0.15, 0.15, 0.45]) wheat(ctx, x + dir * 4, 150, 118, a, 1);
        ctx.save(); ctx.fillStyle = INK; ctx.beginPath(); ctx.roundRect(x - 30, 112, 60, 14, 7); ctx.fill(); ctx.restore();
      }
      sticker(ctx, "🌽", W / 2, 86, 92, 0.25);
      L.photos.forEach((p) => {
        wheat(ctx, 24, p.y + p.h - 4, p.h * 0.55, 0.05, 0.7);
        wheat(ctx, W - 24, p.y + p.h * 0.6, p.h * 0.45, -0.05, 0.7);
      });
      L.photos.forEach((p, i) => sticker(ctx, ["🎃", "🍎", "🌽", "🍇"][i % 4], i % 2 ? p.x + 22 : p.x + p.w - 22, p.y + p.h - 16, 68, (rand() - 0.5) * 0.5));
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
const QR_MODULE = 5;        // px per QR module: 5 dots ≈ 0.6 mm, scans off thermal paper

const QR_PAD = 30;          // paper above + below the QR block

export function layout(theme, frames, footer = "", qr = "") {
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
  const qrY = stubY + STUB + (footer ? 40 : 0);
  const qrSz = qr ? qrSide(qr, QR_MODULE) : 0;
  return { photos, stubY, qrY, qrSide: qrSz, H: qrY + (qr ? qrSz + QR_PAD : 0) };
}

/** Centre cover-crop of an fw×fh source into a w×h slot: source rect. */
export function coverCrop(fw, fh, w, h) {
  const sa = fw / fh, da = w / h;
  let sw = fw, sh = fh;
  if (sa > da) sw = sh * da; else sh = sw / da;
  return { sx: (fw - sw) / 2, sy: (fh - sh) / 2, sw, sh };
}

/**
 * Face boxes in frame pixels → tile pixels through the cover-crop, clipped to
 * the tile. Boxes mostly cropped away (<30% left) are dropped.
 */
export function facesToTile(faces, crop, w, h) {
  if (!Array.isArray(faces)) return [];
  const k = w / crop.sw, out = [];
  for (const f of faces) {
    if (!f || !(f.w > 0 && f.h > 0)) continue;
    const x0 = (f.x - crop.sx) * k, y0 = (f.y - crop.sy) * k;
    const x1 = x0 + f.w * k, y1 = y0 + f.h * k;
    const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(w, x1), cy1 = Math.min(h, y1);
    if (cx1 <= cx0 || cy1 <= cy0) continue;
    if ((cx1 - cx0) * (cy1 - cy0) < 0.3 * (x1 - x0) * (y1 - y0)) continue;
    out.push({ x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 });
  }
  return out;
}

/**
 * Cover-crop + tone-map a frame into a w×h canvas. `faces` (optional): boxes
 * {x,y,w,h} in frame pixels, used to meter exposure on the faces.
 */
function photoTile(frame, w, h, faces) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const crop = coverCrop(frame.width, frame.height, w, h);
  ctx.drawImage(frame, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const g = toneMap(luminance(img.data, w, h), { width: w, height: h, faces: facesToTile(faces, crop, w, h) });
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

/** "Scan me for your photos": phone sticker → arrow → QR code (no words). */
function qrBlock(ctx, L, url) {
  const side = L.qrSide, x = W - side - 26, y = L.qrY + 6;
  ctx.save();
  ctx.fillStyle = INK; ctx.fillRect(x + 8, y + 8, side, side);              // hard offset block, like the photos
  drawQR(ctx, url, x, y, QR_MODULE);
  ctx.strokeStyle = INK; ctx.lineWidth = 5; ctx.strokeRect(x - 2, y - 2, side + 4, side + 4);
  // arrow from the phone to the code
  const ay = y + side / 2, ax0 = 200, ax1 = x - 26;
  ctx.lineWidth = 10; ctx.lineCap = "round"; ctx.setLineDash([2, 18]);
  ctx.beginPath(); ctx.moveTo(ax0, ay); ctx.lineTo(ax1 - 16, ay); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = INK; ctx.beginPath(); ctx.moveTo(ax1, ay); ctx.lineTo(ax1 - 30, ay - 22); ctx.lineTo(ax1 - 30, ay + 22); ctx.closePath(); ctx.fill();
  ctx.restore();
  sticker(ctx, "📲", 110, ay, 96, -0.12);
}

/**
 * Build the full grayscale strip. frames: canvases already rotated upright.
 * faces (optional): one array per frame of face boxes {x,y,w,h} in that
 * frame's pixel coords (missing/empty → centre-weighted metering).
 * Returns { canvas, layout }.
 */
export function compose(frames, { theme = "stars", seed = 1, footer = "", ticket = 1, date = new Date(), faces = [], qr = "" } = {}) {
  const t = THEMES[theme] ?? THEMES.plain;
  const L = layout(theme, frames, footer, qr);
  const rand = rng(seed);
  const c = new OffscreenCanvas(W, L.H);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, L.H);

  t.bg?.(ctx, L, rand);

  L.photos.forEach((p, i) => {
    const tile = photoTile(frames[i], p.w, p.h, faces?.[i]);
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
  if (qr) qrBlock(ctx, L, qr);
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
