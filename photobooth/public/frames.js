// Strip layouts + decorative themes. Everything is drawn in pure black/white
// (or emoji stickers) on a 576px-wide canvas; photos arrive already
// tone-mapped. The whole canvas is dithered afterwards, and solid B/W art
// survives dithering untouched.

import { PRINT_WIDTH as W, luminance, toneMap } from "./raster.js";

// Small seeded PRNG so re-composing (e.g. after rotating a photo) keeps the
// same sticker/confetti placement.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const FONT = "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif";

// ---- primitives -----------------------------------------------------------

function star(ctx, cx, cy, r, points = 5, inner = 0.45) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (Math.PI * i) / points - Math.PI / 2;
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

/** Black shape with a white halo so it reads on top of photos. */
function stamp(ctx, draw, { fill = true, halo = 5, line = 3 } = {}) {
  ctx.save();
  draw();
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#fff"; ctx.lineWidth = halo * 2 + line; ctx.stroke();
  if (fill) { ctx.fillStyle = "#000"; ctx.fill(); }
  else { ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#000"; ctx.lineWidth = line; ctx.stroke(); }
  ctx.restore();
}

/** Emoji sticker with a thick white outline (die-cut look). */
function sticker(ctx, emoji, x, y, size, angle = 0) {
  const S = Math.ceil(size * 1.6), o = Math.max(4, size * 0.08);
  const art = new OffscreenCanvas(S, S), a = art.getContext("2d");
  a.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  a.textAlign = "center"; a.textBaseline = "middle";
  a.fillText(emoji, S / 2, S / 2);
  // Dilate the emoji's silhouette and flood it white.
  const halo = new OffscreenCanvas(S, S), h = halo.getContext("2d");
  for (let k = 0; k < 16; k++) {
    const t = (Math.PI * 2 * k) / 16;
    h.drawImage(art, Math.cos(t) * o, Math.sin(t) * o);
  }
  h.globalCompositeOperation = "source-in";
  h.fillStyle = "#fff"; h.fillRect(0, 0, S, S);
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle);
  ctx.drawImage(halo, -S / 2, -S / 2);
  ctx.drawImage(art, -S / 2, -S / 2);
  ctx.restore();
}

function scatter(rand, n, boxes, fn) {
  for (let i = 0; i < n; i++) {
    const b = boxes[Math.floor(rand() * boxes.length)];
    fn(b.x + rand() * b.w, b.y + rand() * b.h, rand);
  }
}

// Margin regions around the photos (for confetti/stars).
function margins(L) {
  const boxes = [{ x: 0, y: 0, w: W, h: L.photos[0].y - 6 }];
  for (const p of L.photos) {
    boxes.push({ x: 0, y: p.y, w: p.x - 6, h: p.h });
    boxes.push({ x: p.x + p.w + 6, y: p.y, w: W - p.x - p.w - 6, h: p.h });
  }
  const last = L.photos[L.photos.length - 1];
  boxes.push({ x: 0, y: last.y + last.h + 6, w: W, h: L.footerY - last.y - last.h - 30 });
  return boxes.filter((b) => b.w > 8 && b.h > 8);
}

// ---- themes ---------------------------------------------------------------
// Each theme: icon (kid picker), margin, top, bottom, gap, tilt, bg(), fg().

export const THEMES = {
  film: {
    icon: "🎞️", margin: 46, top: 36, bottom: 120, gap: 22, tilt: 0,
    bg(ctx, L) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 34, L.H); ctx.fillRect(W - 34, 0, 34, L.H);
      ctx.fillStyle = "#fff";
      for (let y = 14; y < L.H - 20; y += 40) {
        ctx.beginPath(); ctx.roundRect(9, y, 16, 22, 4); ctx.roundRect(W - 25, y, 16, 22, 4); ctx.fill();
      }
    },
    fg() {},
  },

  stars: {
    icon: "⭐", margin: 40, top: 130, bottom: 130, gap: 30, tilt: 1.8,
    fg(ctx, L, rand) {
      // Big shooting-star cluster on top.
      stamp(ctx, () => star(ctx, W / 2, 66, 46));
      stamp(ctx, () => star(ctx, W / 2 - 110, 76, 26), { fill: false });
      stamp(ctx, () => star(ctx, W / 2 + 110, 76, 26), { fill: false });
      stamp(ctx, () => star(ctx, W / 2 - 190, 54, 14));
      stamp(ctx, () => star(ctx, W / 2 + 190, 54, 14));
      // Corner stars hanging over each photo.
      for (const p of L.photos) {
        const r = 20 + rand() * 14;
        const [cx, cy] = rand() < 0.5 ? [p.x + 8, p.y + 8] : [p.x + p.w - 8, p.y + p.h - 8];
        stamp(ctx, () => star(ctx, cx, cy, r), { fill: rand() < 0.6 });
      }
      scatter(rand, 26, margins(L), (x, y, r) =>
        stamp(ctx, () => star(ctx, x, y, 4 + r() * 8), { halo: 0, fill: r() < 0.7, line: 2 }));
    },
  },

  hearts: {
    icon: "💖", margin: 40, top: 120, bottom: 130, gap: 30, tilt: 1.5,
    fg(ctx, L, rand) {
      for (let i = -3; i <= 3; i++) {
        const s = 30 - Math.abs(i) * 5;
        stamp(ctx, () => heart(ctx, W / 2 + i * 72, 64 + Math.abs(i) * 6, s), { fill: i % 2 === 0 });
      }
      for (const p of L.photos) {
        stamp(ctx, () => heart(ctx, p.x + p.w - 14, p.y + 14, 22 + rand() * 10));
      }
      scatter(rand, 22, margins(L), (x, y, r) =>
        stamp(ctx, () => heart(ctx, x, y, 5 + r() * 7), { halo: 0, fill: r() < 0.6, line: 2 }));
    },
  },

  party: {
    icon: "🎉", margin: 40, top: 130, bottom: 130, gap: 30, tilt: 2.2,
    fg(ctx, L, rand) {
      // Bunting garland.
      ctx.save();
      ctx.strokeStyle = "#000"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, 22); ctx.quadraticCurveTo(W / 2, 80, W, 22); ctx.stroke();
      for (let i = 0; i < 9; i++) {
        const t = (i + 0.5) / 9, x = t * W;
        const y = (1 - t) * (1 - t) * 22 + 2 * (1 - t) * t * 80 + t * t * 22;
        ctx.beginPath(); ctx.moveTo(x - 24, y); ctx.lineTo(x + 24, y); ctx.lineTo(x, y + 52); ctx.closePath();
        if (i % 3 === 0) { ctx.fillStyle = "#000"; ctx.fill(); }
        else {
          ctx.fillStyle = "#fff"; ctx.fill(); ctx.stroke();
          if (i % 3 === 1) { ctx.beginPath(); ctx.arc(x, y + 16, 6, 0, Math.PI * 2); ctx.fillStyle = "#000"; ctx.fill(); }
          else { ctx.beginPath(); ctx.moveTo(x - 14, y + 8); ctx.lineTo(x + 14, y + 8); ctx.moveTo(x - 8, y + 22); ctx.lineTo(x + 8, y + 22); ctx.stroke(); }
        }
      }
      ctx.restore();
      scatter(rand, 60, margins(L), (x, y, r) => {
        ctx.save(); ctx.translate(x, y); ctx.rotate(r() * Math.PI);
        ctx.fillStyle = "#000";
        const k = r();
        if (k < 0.4) ctx.fillRect(-7, -3, 14, 6);
        else if (k < 0.7) { ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI * 2); ctx.fill(); }
        else { ctx.strokeStyle = "#000"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-8, 0); ctx.quadraticCurveTo(0, -8, 8, 0); ctx.stroke(); }
        ctx.restore();
      });
      for (const p of L.photos) sticker(ctx, rand() < 0.5 ? "🎈" : "🥳", p.x + p.w - 10, p.y + p.h - 14, 70, (rand() - 0.5) * 0.5);
    },
  },

  dino: {
    icon: "🦖", margin: 36, top: 120, bottom: 150, gap: 34, tilt: 1.2,
    fg(ctx, L, rand) {
      const pals = ["🦖", "🦕", "🦖", "🦕"];
      sticker(ctx, "🦕", 90, 64, 96, -0.1);
      sticker(ctx, "🌋", W / 2, 60, 84);
      sticker(ctx, "🦖", W - 90, 64, 96, 0.1);
      L.photos.forEach((p, i) => {
        const left = i % 2 === 0;
        sticker(ctx, pals[i % 4], left ? p.x + 30 : p.x + p.w - 30, p.y + p.h - 20, 78, (rand() - 0.5) * 0.4);
      });
      // Grass + footprints along the bottom.
      ctx.save(); ctx.fillStyle = "#000";
      const gy = L.H - 14;
      ctx.beginPath(); ctx.moveTo(0, L.H);
      for (let x = 0; x <= W; x += 12) ctx.lineTo(x, gy - (x / 12 % 2 ? 6 + rand() * 18 : 0));
      ctx.lineTo(W, L.H); ctx.closePath(); ctx.fill();
      ctx.restore();
    },
  },

  space: {
    icon: "🚀", margin: 40, top: 130, bottom: 130, gap: 30, tilt: 0,
    bg(ctx, L, rand) {
      ctx.fillStyle = "#000";
      scatter(rand, 140, margins(L), (x, y, r) => { ctx.beginPath(); ctx.arc(x, y, 0.8 + r() * 2.2, 0, Math.PI * 2); ctx.fill(); });
    },
    fg(ctx, L, rand) {
      // Ringed planet.
      ctx.save(); ctx.translate(120, 66); ctx.rotate(-0.35);
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, 38, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(0, 0, 68, 16, 0, 0, Math.PI * 2); ctx.lineWidth = 6; ctx.stroke();
      ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(-12, -10, 7, 0, Math.PI * 2); ctx.arc(14, 12, 5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      sticker(ctx, "🚀", W - 110, 66, 92, 0.6);
      sticker(ctx, "🌙", W / 2 + 20, 56, 56);
      for (const p of L.photos) sticker(ctx, rand() < 0.5 ? "👽" : "🛸", p.x + p.w - 18, p.y + 18, 64, (rand() - 0.5) * 0.5);
    },
  },

  plain: {
    icon: "📷", margin: 28, top: 28, bottom: 110, gap: 20, tilt: 0,
    fg() {},
  },
};

// ---- layout + compose -------------------------------------------------------

/** Clamp a photo's aspect to booth slots: landscape 4:3, portrait 4:5. */
const slotAspect = (w, h) => (w >= h ? 4 / 3 : 4 / 5);

export function layout(theme, frames) {
  const t = THEMES[theme] ?? THEMES.plain;
  const pw = W - 2 * t.margin;
  let y = t.top;
  const photos = frames.map((f) => {
    const h = Math.round(pw / slotAspect(f.width, f.height));
    const r = { x: t.margin, y, w: pw, h };
    y += h + t.gap;
    return r;
  });
  const footerY = y - t.gap + 34;
  return { photos, footerY, H: y - t.gap + t.bottom };
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

/**
 * Build the full grayscale strip. frames: canvases already rotated upright.
 * Returns { canvas, layout }.
 */
export function compose(frames, { theme = "stars", seed = 1, footer = "", date = new Date() } = {}) {
  const t = THEMES[theme] ?? THEMES.plain;
  const L = layout(theme, frames);
  const rand = rng(seed);
  const c = new OffscreenCanvas(W, L.H);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, L.H);

  t.bg?.(ctx, L, rand);

  L.photos.forEach((p, i) => {
    const tile = photoTile(frames[i], p.w, p.h);
    const tilt = t.tilt ? ((rand() - 0.5) * 2 * t.tilt * Math.PI) / 180 : 0;
    ctx.save();
    ctx.translate(p.x + p.w / 2, p.y + p.h / 2); ctx.rotate(tilt);
    ctx.fillStyle = "#fff"; ctx.fillRect(-p.w / 2 - 8, -p.h / 2 - 8, p.w + 16, p.h + 16);
    ctx.drawImage(tile, -p.w / 2, -p.h / 2);
    ctx.strokeStyle = "#000"; ctx.lineWidth = 4; ctx.strokeRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  });

  t.fg(ctx, L, rand);

  // Footer: date stamp (+ optional host text).
  const d = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }).toUpperCase();
  const tm = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = `800 30px ${FONT}`;
  const label = `${d}  ·  ${tm}`;
  const tw = Math.min(W - 120, ctx.measureText(label).width + 36);
  ctx.fillStyle = "#000";
  ctx.beginPath(); ctx.roundRect(W / 2 - tw / 2, L.footerY - 22, tw, 44, 22); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.fillText(label, W / 2, L.footerY + 1, tw - 30);
  if (footer) {
    ctx.fillStyle = "#000"; ctx.font = `600 26px ${FONT}`;
    ctx.fillText(footer, W / 2, L.footerY + 46, W - 80);
  }
  ctx.restore();
  return { canvas: c, layout: L };
}

/** Calibration strip: one band per thermal gain, black block over greys. */
export function calibrationGray(gains) {
  const bandH = 300, H = bandH * gains.length + 40;
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "middle";
  gains.forEach((g, i) => {
    const y = 20 + i * bandH;
    ctx.fillStyle = "#000"; ctx.font = `800 34px ${FONT}`;
    ctx.fillText(String.fromCharCode(65 + i), 12, y + 50);
    // Black block on the left 2/3; right third is the un-heated reference.
    ctx.fillRect(60, y, 320, 100);
    // Grey bands beneath, full width: 25%, 50%, then a gradient.
    ctx.fillStyle = "rgb(191,191,191)"; ctx.fillRect(60, y + 100, W - 80, 60);
    ctx.fillStyle = "rgb(128,128,128)"; ctx.fillRect(60, y + 160, W - 80, 60);
    const gr = ctx.createLinearGradient(60, 0, W - 20, 0);
    gr.addColorStop(0, "#fff"); gr.addColorStop(1, "#000");
    ctx.fillStyle = gr; ctx.fillRect(60, y + 220, W - 80, 40);
  });
  const img = ctx.getImageData(0, 0, W, H);
  return { gray: luminance(img.data, W, H), H, bandH };
}
