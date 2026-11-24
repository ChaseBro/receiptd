// Golden QR matrices from the web app's encoder (public/qr.js → vendored
// qrcode-generator), for BoothCore's QRTests. Run from photobooth/:
//   node ios/parity/gen-qr.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { qrMatrix } from "../../public/qr.js";

const out = fileURLToPath(new URL("../BoothCore/Tests/BoothCoreTests/Fixtures/qr.json", import.meta.url));

const ids = ["abcdefghjkmn", "zyxwvutsrqpm", "a2b3c4d5e6f7", "kkkkkkkkkkkk"];
const texts = [
  "a",
  " ",
  "0",
  "Hello, world!",
  "HELLO WORLD",
  "01234567890123456789",
  "https://booth.receiptd.sh",
  "https://booth.receiptd.sh/a/abcdefghjkmn/mfx3k2a1-1a2b3c4d",
  "https://booth.receiptd.sh/a/zyxwvutsrqpm/mg00000z-ffffffff",
  "https://booth.receiptd.sh/a/a2b3c4d5e6f7/mfx3k2a1-00000000",
  ...ids.map((a, i) => `https://booth-staging.receiptd.sh/a/${a}/m${i}x9k2b7-${(0x9e3779b9 * (i + 1) >>> 0).toString(16).padStart(8, "0")}`),
  "https://booth.receiptd.sh/p/abcdefghjkmn",
  "café crème",
  "party 🦃🥧 time",
  "ünïcødé ✓",
  // Byte-mode capacities at M: v1=14, v2=26, v3=42, v4=62, v9=180, v10=213 (16-bit length).
  "x".repeat(14),
  "x".repeat(15),
  "y".repeat(26),
  "y".repeat(27),
  "z".repeat(42),
  "z".repeat(43),
  "q".repeat(180),
  "q".repeat(181),
  "The quick brown fox jumps over the lazy dog. ".repeat(8),
  Array.from({ length: 600 }, (_, i) => String.fromCharCode(33 + (i * 7) % 94)).join(""),
];
const allLevels = new Set(["a", "Hello, world!", "https://booth.receiptd.sh/a/abcdefghjkmn/mfx3k2a1-1a2b3c4d",
  "z".repeat(43), "café crème", "The quick brown fox jumps over the lazy dog. ".repeat(8)]);

const cases = [];
for (const text of texts) {
  for (const level of allLevels.has(text) ? ["L", "M", "Q", "H"] : ["M"]) {
    const { n, dark } = qrMatrix(text, level);
    const rows = [];
    for (let r = 0; r < n; r++) {
      let s = "";
      for (let c = 0; c < n; c++) s += dark(r, c) ? "1" : "0";
      rows.push(s);
    }
    cases.push({ text, level, n, rows });
  }
}
writeFileSync(out, JSON.stringify(cases) + "\n");
console.log(`wrote ${cases.length} cases → ${out}`);
console.log([...new Set(cases.map((c) => c.n))].sort((a, b) => a - b).join(" "));
