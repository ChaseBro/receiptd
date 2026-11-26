// Party signs (public/sign.js): the "use your own phone" web-booth sign and the album sign.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webSignHTML, albumSignHTML } from "../public/sign.js";
import { qrSVG } from "../public/qr.js";
import { K } from "../public/icons.js";

const visibleText = (html) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]*>/g, " ");

test("web sign: QR is the unlocked web booth link; the PIN is never printed as text", () => {
  const pin = "Gobble Gobble 77";
  const html = webSignHTML({ server: "https://booth.receiptd.sh/party.html", pin });
  assert.ok(html.includes(qrSVG("https://booth.receiptd.sh/#pin=Gobble%20Gobble%2077", 3)), "QR → <origin>/#pin=<PIN>");
  assert.ok(!visibleText(html).includes("Gobble"), "PIN not in visible text");
  assert.ok(!html.replace(/<path d="[^"]*"/g, "").includes("Gobble"), "PIN nowhere but the QR modules");
  assert.match(visibleText(html), /no app needed/);
  assert.equal((html.match(/class="sg-step"/g) ?? []).length, 3, "three steps");
  assert.ok(!/TestFlight/i.test(html), "no TestFlight content");
});

test("album sign: QR → album link, title escaped", () => {
  const html = albumSignHTML({ name: "Pie <script>", date: "Thursday", url: "https://booth.receiptd.sh/a/tok" });
  assert.ok(html.includes(qrSVG("https://booth.receiptd.sh/a/tok", 3)));
  assert.ok(!html.includes("<script>") && html.includes("Pie &lt;script&gt;"));
});

test("signs: token colours only (QR pure #000/#fff), no emoji glyphs", () => {
  const tokens = new Set(Object.values(K).map((c) => c.toUpperCase()));
  for (const html of [webSignHTML({ server: "https://b.example", pin: "1234" }), albumSignHTML({ name: "Party", url: "https://b.example/a/x" })]) {
    const qr = /<rect width="\d+" height="\d+" fill="#fff"\/><path d="[^"]*" fill="#000"\/>/g;
    const bad = [...html.replace(qr, "").matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toUpperCase()).filter((c) => !tokens.has(c));
    assert.deepEqual([...new Set(bad)], [], "non-token colours");
    assert.ok(!/\p{Extended_Pictographic}/u.test(html), "no emoji on the sign");
  }
  const src = readFileSync(new URL("../public/sign.js", import.meta.url), "utf8");
  assert.ok(!/(?<!&)#[0-9a-f]{3,8}\b/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/#\[0-9A-Fa-f\]\{6\}/, "")), "sign.js paints through K.* only");
});
