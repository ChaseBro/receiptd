// Renders every drawn icon (72 px + 44 px sticker buttons) next to its Classic look, from the
// shipped public/icons.js, into ios/build/shots/redesign/web-icon-sheet.png. Local booth only.
import { chromium } from "playwright";
const BASE = process.env.BASE ?? "http://localhost:8788";
const OUT = new URL("../ios/build/shots/redesign/web-icon-sheet.png", import.meta.url).pathname;
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
await page.goto(BASE + "/favicon.ico").catch(() => {});
await page.goto(BASE + "/manifest.webmanifest");
await page.evaluate(async () => {
  const m = await import("/icons.js");
  document.documentElement.innerHTML = `<head><style>
    @font-face { font-family:"Lilita"; src:url("/fonts/lilita-one.woff2"); }
    body { margin:0; padding:20px; background:#FFF4DC; font:600 12px ui-rounded, system-ui; color:#1A1423; }
    .g { display:grid; grid-template-columns:repeat(4, 1fr); gap:14px; }
    .c { display:flex; flex-direction:column; align-items:center; gap:6px; }
    .r { display:flex; gap:10px; align-items:center; }
    .b { display:flex; align-items:center; justify-content:center; background:#fff; border:4px solid #1A1423; border-radius:50%; box-shadow:5px 5px 0 #1A1423; }
    .b72 { width:72px; height:72px; } .b44 { width:44px; height:44px; border-width:3px; box-shadow:3px 3px 0 #1A1423; }
    .ic { width:74%; height:74%; overflow:visible; } .b44 .ic { width:82%; height:82%; }
    .emoji { font-family:"Apple Color Emoji","Noto Color Emoji",sans-serif; font-size:34px; }
    .strip-ico { display:flex; flex-direction:column; gap:3px; padding:4px; background:#fff; border:3px solid #1A1423; border-radius:5px; }
    .strip-ico b { display:block; width:18px; height:10px; background:#1A1423; border-radius:2px; } .strip-ico.one b { width:24px; height:24px; }
    .ico { width:60%; height:60%; } .ico .paper { fill:#fff; stroke:#1A1423; stroke-width:4; } .ico .inkf { fill:#1A1423; }
    .ico .halo { fill:none; stroke:#fff; stroke-width:11; stroke-linecap:round; } .ico .arrow { fill:none; stroke:#1A1423; stroke-width:5; stroke-linecap:round; }
    .ico .plus { fill:#2EE6A6; stroke:#1A1423; stroke-width:3.5; } .ico .plusbar { fill:none; stroke:#1A1423; stroke-width:4; stroke-linecap:round; }
  </style></head><body>${m.ICON_DEFS}<div class="g">${m.ICON_NAMES.map((n) => `<div class="c">
    <div class="r"><div class="b b72">${m.iconHTML(n, "classic")}</div><div class="b b72">${m.drawnSVG(n)}</div><div class="b b44">${m.drawnSVG(n)}</div></div>${n}</div>`).join("")}</div></body>`;
  await document.fonts.load("20px Lilita");
});
await page.waitForTimeout(500);
const h = await page.evaluate(() => document.body.scrollHeight);
await page.setViewportSize({ width: 1100, height: h + 20 });
await page.screenshot({ path: OUT });
await b.close();
console.log(OUT);
