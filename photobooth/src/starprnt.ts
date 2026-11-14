// Minimal StarPRNT encoder for a full-width 1-bit raster + feed + cut.
//
// Byte layout mirrors what Star's cputil emits for
//   [image: url …; width 100%]\n[feed:3][cut]
// (captured with `cputil thermal3 decode application/vnd.star.starprnt`),
// so the printer sees exactly the stream the Go server used to send.

export const RASTER_WIDTH_PX = 576; // 80mm @ 203dpi
const BYTES_PER_ROW = RASTER_WIDTH_PX / 8;
const BAND_ROWS = 256;

// ESC @ init, ESC R 0 intl charset, ESC RS F 0 font, ESC SP 0 char spacing,
// ESC l 0 left margin, ESC z 1 line spacing, then the ESC GS ) U / E
// print-setting block cputil writes before rasters.
const HEADER = [
  0x1b, 0x40,
  0x1b, 0x52, 0x00,
  0x1b, 0x1e, 0x46, 0x00,
  0x1b, 0x20, 0x00,
  0x1b, 0x6c, 0x00,
  0x1b, 0x7a, 0x01,
  0x1b, 0x1d, 0x29, 0x55, 0x02, 0x00, 0x30, 0x01,
  0x1b, 0x1d, 0x29, 0x55, 0x02, 0x00, 0x40, 0x00,
  0x1b, 0x1d, 0x29, 0x45, 0x02, 0x00, 0x30, 0x00,
];

// Image line break + `[feed:3]` as cputil encodes them, then ESC d 3 (feed to cutter + cut).
const TRAILER = [0x0d, 0x0a, 0x0d, 0x0a, 0x1b, 0x64, 0x03];

/** raster: rows of BYTES_PER_ROW bytes, MSB = leftmost pixel, 1 = black. */
export function buildStarPRNT(raster: Uint8Array, height: number): Uint8Array {
  const bands = Math.ceil(height / BAND_ROWS);
  const out = new Uint8Array(HEADER.length + raster.length + bands * 9 + TRAILER.length);
  let o = 0;
  out.set(HEADER, o);
  o += HEADER.length;
  for (let y = 0; y < height; y += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - y);
    // ESC GS S m=1 xL xH yL yH n=0
    out.set([0x1b, 0x1d, 0x53, 0x01, BYTES_PER_ROW & 0xff, BYTES_PER_ROW >> 8, rows & 0xff, rows >> 8, 0x00], o);
    o += 9;
    out.set(raster.subarray(y * BYTES_PER_ROW, (y + rows) * BYTES_PER_ROW), o);
    o += rows * BYTES_PER_ROW;
  }
  out.set(TRAILER, o);
  return out;
}
