// Zero-dependency encoders for the photo archive. Pure (no DOM), so they run
// under `node --test` as well as in the booth and the gallery.
//   crc32(bytes)                      CRC-32 (zip + png)
//   encodeBitPNG(bits, w, h)          1 bit/px array (1 = black) → true B/W PNG bytes
//   zipStore(entries)                 [{ name, data: Uint8Array, date? }] → zip parts (STORE, no compression)

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i += 5552) {           // NMAX: no overflow before the modulo
    for (let j = i, end = Math.min(i + 5552, bytes.length); j < end; j++) { a += bytes[j]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream of uncompressed ("stored") deflate blocks — the no-CompressionStream fallback. */
export function zlibStored(bytes) {
  const n = Math.max(1, Math.ceil(bytes.length / 65535));
  const out = new Uint8Array(2 + bytes.length + n * 5 + 4), dv = new DataView(out.buffer);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < n; i++) {
    const part = bytes.subarray(i * 65535, (i + 1) * 65535);
    out[o] = i === n - 1 ? 1 : 0;                              // BFINAL, BTYPE=00
    dv.setUint16(o + 1, part.length, true); dv.setUint16(o + 3, ~part.length & 0xffff, true);
    out.set(part, o + 5); o += 5 + part.length;
  }
  dv.setUint32(o, adler32(bytes));
  return out;
}

/** zlib-wrapped deflate via CompressionStream (Safari 16.4+, Chrome, Node 18+), else stored blocks. */
export async function deflate(bytes) {
  if (typeof CompressionStream !== "function") return zlibStored(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * The printed bitmap as a 1-bit greyscale PNG: pure black/white, no preview tint.
 * `bits` is one byte per pixel (1/true = black), row-major, `w*h` long.
 */
export async function encodeBitPNG(bits, w, h, z = deflate) {
  if (!(w > 0 && h > 0) || bits.length < w * h) throw new Error("bad bitmap");
  const rowBytes = Math.ceil(w / 8), raw = new Uint8Array((rowBytes + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (rowBytes + 1);            // raw[o] = filter 0 (None)
    for (let x = 0; x < w; x++) {
      // PNG greyscale: 1 = white. Our bitmap: 1 = black (ink).
      if (!bits[y * w + x]) raw[o + 1 + (x >> 3)] |= 0x80 >> (x & 7);
    }
    // Padding bits past `w` stay 0 (black) — ignored by decoders.
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr.set([1, 0, 0, 0, 0], 8);              // bit depth 1, greyscale, deflate, filter 0, no interlace
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", await z(raw)), chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Minimal STORE-only zip (no compression: JPEG/PNG are already compressed).
 * Returns an array of Uint8Array parts — `new Blob(parts, { type: "application/zip" })`.
 * Limits: < 65535 entries and < 4 GiB total (no zip64).
 */
export function zipStore(entries) {
  if (entries.length >= 0xffff) throw new Error("too many entries");
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), data = e.data, crc = crc32(data);
    const { time, date } = dosTime(e.date ?? new Date());
    const local = new Uint8Array(30 + name.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); lv.setUint16(10, time, true); lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length), cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true); cv.setUint16(12, time, true); cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, data); central.push(cd);
    offset += local.length + data.length;
    if (offset >= 0xffffffff) throw new Error("zip too large");
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22), ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  return [...parts, ...central, end];
}
