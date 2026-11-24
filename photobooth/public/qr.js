// QR codes for strips (link to the guest's photos) and party signs.
// Pure ink: modules are whole-pixel #000 squares on #fff, so they survive the
// dither untouched and scan off thermal paper.

import qrcode from "./vendor/qrcode/qrcode.mjs";

/** text → { n, dark(r, c) }. Level M (15% damage) suits curled thermal paper. */
export function qrMatrix(text, level = "M") {
  const q = qrcode(0, level);
  q.addData(text, "Byte");
  q.make();
  const n = q.getModuleCount();
  return { n, dark: (r, c) => q.isDark(r, c) };
}

/**
 * Draw a QR code with its top-left at (x, y): `module` px per module (integer),
 * plus a white quiet zone of `quiet` modules. Returns the total side length.
 */
export function drawQR(ctx, text, x, y, module = 5, quiet = 4) {
  const { n, dark } = qrMatrix(text);
  const side = (n + 2 * quiet) * module;
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.fillRect(x, y, side, side);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (dark(r, c)) ctx.fillRect(x + (c + quiet) * module, y + (r + quiet) * module, module, module);
  }
  ctx.restore();
  return side;
}

/** Side length drawQR would use, without drawing. */
export function qrSide(text, module = 5, quiet = 4) {
  return (qrMatrix(text).n + 2 * quiet) * module;
}

/** SVG markup (for on-screen / paper signs). */
export function qrSVG(text, quiet = 4) {
  const { n, dark } = qrMatrix(text);
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const s = n + 2 * quiet;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
