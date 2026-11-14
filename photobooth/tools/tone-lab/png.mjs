// Minimal PNG codec (zlib only): decode 8-bit non-interlaced PNGs of any
// colour type to luminance, encode 8-bit grayscale.
import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePNG(path) {
  const buf = readFileSync(path);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8, w, h, depth, type, interlace, plte, idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), tag = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (tag === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (tag === "PLTE") plte = data;
    else if (tag === "IDAT") idat.push(data);
    else if (tag === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`unsupported depth=${depth} interlace=${interlace}`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, px = new Uint8Array(stride * h);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  // → BT.601 luminance, same weights as public/raster.js luminance()
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let r, g, b;
    if (type === 0 || type === 4) r = g = b = px[i * ch];
    else if (type === 3) { const k = px[i] * 3; r = plte[k]; g = plte[k + 1]; b = plte[k + 2]; }
    else { r = px[i * ch]; g = px[i * ch + 1]; b = px[i * ch + 2]; }
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { w, h, gray };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(b) {
  let c = -1;
  for (const v of b) c = CRC[(c ^ v) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(tag, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(tag, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Write 8-bit grayscale PNG from Float32/Uint8 values 0..255. */
export function encodeGrayPNG(path, gray, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    raw[y * (w + 1) + 1 + x] = Math.max(0, Math.min(255, Math.round(gray[y * w + x])));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  writeFileSync(path, Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}
