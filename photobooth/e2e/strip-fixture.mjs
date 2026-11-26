// Real-looking sessions for e2e: colour "photos" plus the strip the booth would print from them
// (the booth's own frames.js + raster.js, dithered like index.html: QR band at gain 0, no relief).
// `page` must be on the booth's origin (it imports /frames.js).

/** → { strip: Buffer (576-wide PNG, black/white), origs: Buffer[] (JPEG) } */
export async function makeSession(page, { theme = "turkey", shots = 1, qr = "", seed = 1, ticket = 7 } = {}) {
  const r = await page.evaluate(async ({ theme, shots, qr, seed, ticket }) => {
    const font = new FontFace("Lilita", "url(/fonts/lilita-one.woff2)"); document.fonts.add(await font.load());
    const { compose } = await import("/frames.js");
    const { luminance, ditherThermal, relieveSolids, PRINT_WIDTH: W } = await import("/raster.js");
    let s = seed * 7919 + 13; const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const hues = [12, 45, 160, 200, 280, 330];
    const frames = Array.from({ length: shots }, (_, i) => {
      const c = document.createElement("canvas"); c.width = 1440; c.height = 1080; const x = c.getContext("2d");
      const h = hues[(seed + i) % hues.length];
      const g = x.createLinearGradient(0, 0, 1440, 1080); g.addColorStop(0, `hsl(${h} 80% 72%)`); g.addColorStop(1, `hsl(${(h + 60) % 360} 70% 38%)`);
      x.fillStyle = g; x.fillRect(0, 0, 1440, 1080);
      for (let k = 0; k < 8; k++) { x.fillStyle = `hsl(${(h + k * 40) % 360} 85% ${40 + rnd() * 40}%)`; x.beginPath(); x.arc(rnd() * 1440, rnd() * 1080, 60 + rnd() * 160, 0, 7); x.fill(); }
      // a big smiley "guest"
      const cx = 520 + i * 180, cy = 560;
      x.fillStyle = "hsl(35 70% 72%)"; x.beginPath(); x.arc(cx, cy, 260, 0, 7); x.fill();
      x.fillStyle = "#222"; for (const dx of [-90, 90]) { x.beginPath(); x.arc(cx + dx, cy - 60, 34, 0, 7); x.fill(); }
      x.lineWidth = 26; x.strokeStyle = "#222"; x.beginPath(); x.arc(cx, cy + 20, 140, 0.2, Math.PI - 0.2); x.stroke();
      return c;
    });
    const { canvas, layout } = compose(frames, { theme, seed, ticket, qr, footer: "", date: new Date("2026-11-26T17:39:00-05:00") });
    const H = layout.H, gray = luminance(canvas.getContext("2d").getImageData(0, 0, W, H).data, W, H);
    const segs = layout.qrSide
      ? [{ y0: 0, y1: layout.qrY, opts: { gain: 0.15, bleed: 0 } }, { y0: layout.qrY, y1: H, opts: { gain: 0, bleed: 0, relief: 0 } }]
      : [{ y0: 0, y1: H, opts: { gain: 0.15, bleed: 0 } }];
    const bits = new Uint8Array(W * H), state = { sink: 0 };
    for (const sg of segs) {
      const d = ditherThermal(gray.subarray(sg.y0 * W, sg.y1 * W), W, sg.y1 - sg.y0, sg.opts);
      bits.set((sg.opts.relief ?? 1) ? relieveSolids(d, W, sg.y1 - sg.y0, { strength: 1, state }) : d, sg.y0 * W);
    }
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const ox = out.getContext("2d"), img = ox.createImageData(W, H);
    for (let i = 0; i < bits.length; i++) { const v = bits[i] ? 0 : 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    ox.putImageData(img, 0, 0);
    const b64 = async (c, type, q) => { const bl = await new Promise((r) => c.toBlob(r, type, q)); const u8 = new Uint8Array(await bl.arrayBuffer()); let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    return { strip: await b64(out, "image/png"), origs: await Promise.all(frames.map((f) => b64(f, "image/jpeg", 0.8))) };
  }, { theme, shots, qr, seed, ticket });
  return { strip: Buffer.from(r.strip, "base64"), origs: r.origs.map((o) => Buffer.from(o, "base64")) };
}
