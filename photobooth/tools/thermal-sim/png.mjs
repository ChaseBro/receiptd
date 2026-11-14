// Minimal PNG codec (no deps): decode 8-bit non-interlaced PNGs of any colour
// type to luminance, encode 8-bit grayscale.
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** → { w, h, gray: Float32Array 0..255 } or throws on unsupported input. */
export function decodePNG(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w, h, depth, ctype, interlace, plte = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === "PLTE") plte = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported depth=${depth} interlace=${interlace}`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? px[row + i - ch] : 0, b = y ? px[row - stride + i] : 0;
      const c = i >= ch && y ? px[row - stride + i - ch] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + i] = v;
    }
  }
  const gray = new Float32Array(w * h);
  for (let j = 0; j < w * h; j++) {
    let r, g, b, al = 255;
    if (ctype === 0 || ctype === 4) { r = g = b = px[j * ch]; if (ctype === 4) al = px[j * ch + 1]; }
    else if (ctype === 3) { const k = px[j] * 3; r = plte[k]; g = plte[k + 1]; b = plte[k + 2]; }
    else { r = px[j * ch]; g = px[j * ch + 1]; b = px[j * ch + 2]; if (ctype === 6) al = px[j * ch + 3]; }
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    gray[j] = (l * al + 255 * (255 - al)) / 255; // composite on white paper
  }
  return { w, h, gray };
}

/** Write 8-bit grayscale PNG. pix: array-like of 0..255. */
export function encodePNG(path, pix, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(pix[y * w + x])));
  }
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); t.copy(out, 4); out.writeUInt32BE(crc32(t), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0)),
  ]));
}
