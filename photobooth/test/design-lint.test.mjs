// Design lint: enforces the rules in ../DESIGN.md ("Thermal Arcade").
// Zero dependencies — regex over the shipped files, run with `npm run lint`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const frames = readFileSync(new URL("../public/frames.js", import.meta.url), "utf8");
const gallery = readFileSync(new URL("../public/gallery.html", import.meta.url), "utf8");
const party = readFileSync(new URL("../public/party.html", import.meta.url), "utf8");
const album = readFileSync(new URL("../public/album.html", import.meta.url), "utf8");
const mine = readFileSync(new URL("../public/mine.html", import.meta.url), "utf8");
const icons = readFileSync(new URL("../public/icons.js", import.meta.url), "utf8");
const styleOf = (doc) => doc.match(/<style>([\s\S]*?)<\/style>/)[1];
// Token / shadow / font / motion rules apply to every page; the no-words rules only to kid screens.
const SHEETS = { "index.html": styleOf(html), "gallery.html": styleOf(gallery), "party.html": styleOf(party), "album.html": styleOf(album), "mine.html": styleOf(mine) };

// Long-running, deliberate animations (loops or the paper feed).
const AMBIENT = new Set(["wiggle", "bob", "spin", "blink", "feed", "fall"]);
const KID_SCREENS = ["cam", "review", "printing", "done", "mine"];   // "mine": the "your photos" overlay

/** CSS declarations with line numbers; :root and @font-face (token homes) blanked out. */
function declarations() {
  return Object.entries(SHEETS).flatMap(([file, css]) => sheetDecls(css).map((d) => ({ ...d, file })));
}
function sheetDecls(css) {
  const body = css.replace(/(:root|@font-face)\s*\{[^}]*\}/g, (m) => m.replace(/[^\n]/g, " "));
  const out = [];
  body.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)) out.push({ prop: m[1], value: m[2].trim(), line: i + 1 });
  });
  return out;
}
const fail = (bad) => bad.map((d) => `  ${d.file} style line ${d.line}: ${d.prop}: ${d.value}`).join("\n");

test("colours come from tokens (no raw hex/rgb/hsl outside :root)", () => {
  const bad = declarations().filter((d) => /#[0-9a-f]{3,8}\b|\b(rgb|hsl)a?\(/i.test(d.value));
  assert.equal(bad.length, 0, "raw colours:\n" + fail(bad));
});

test("box-shadow only via var(--shadow*)", () => {
  const bad = declarations().filter((d) => d.prop === "box-shadow" && !/^(none|var\(--shadow(-sm|-lg)?\))$/.test(d.value));
  assert.equal(bad.length, 0, "off-token shadows:\n" + fail(bad));
});

test("font-family only via var(--font-*)", () => {
  const bad = declarations().filter((d) => d.prop === "font-family" && !/^var\(--font-[a-z]+\)$/.test(d.value));
  assert.equal(bad.length, 0, "off-token fonts:\n" + fail(bad));
});

test("one-shot animations ≤ 600ms (ambient loops allow-listed)", () => {
  const bad = [];
  for (const d of declarations()) {
    if (d.prop !== "animation" && d.prop !== "transition") continue;
    for (const part of d.value.split(/,(?![^(]*\))/)) {
      const name = part.trim().split(/\s+/)[0];
      if (d.prop === "animation" && (AMBIENT.has(name) || /infinite/.test(part))) continue;
      for (const m of part.matchAll(/(?<![\w-])(\d*\.?\d+)(ms|s)\b/g)) {
        const ms = m[2] === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
        if (ms > 600) bad.push(d);
      }
    }
  }
  assert.equal(bad.length, 0, "slow one-shot motion:\n" + fail(bad));
});

/** Static markup of a kid screen by id (section or div). */
function screen(id) {
  const start = html.search(new RegExp(`<(section|div) id="${id}"`));
  assert.ok(start >= 0, `screen #${id} exists`);
  const tag = html.slice(start + 1, html.indexOf(" ", start));
  let depth = 0, i = start;
  const re = new RegExp(`<(/?)${tag}\\b`, "g");
  re.lastIndex = start;
  for (let m; (m = re.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) { i = m.index; break; }
  }
  return html.slice(start, html.indexOf(">", i) + 1);
}

test("kid screens use no words (emoji, shapes, numerals only)", () => {
  for (const id of KID_SCREENS) {
    const text = screen(id).replace(/<[^>]*>/g, " ");
    const words = text.match(/[A-Za-z]{2,}/g);
    assert.equal(words, null, `#${id} has visible words: ${words}`);
  }
});

test("every kid button has an aria-label", () => {
  for (const id of KID_SCREENS) {
    for (const b of screen(id).match(/<button\b[^>]*>/g) ?? []) {
      assert.match(b, /aria-label="[^"]+"/, `#${id}: ${b}`);
    }
  }
  // Buttons generated at runtime for kid screens.
  assert.match(html, /\$\{v\.icon\}<\/button>/);
  assert.match(html, /<button class="sticker emoji [^`]*aria-label=/, "theme buttons get aria-label");
  assert.match(html, /b\.setAttribute\("aria-label", "Rotate photo"\)/, "rotate buttons get aria-label");
});

// The adult hint layer: the one sanctioned way words reach a kid screen. A small label for
// grown-ups, shown only in answer to a tap/hold on an adult control (gear, make another booth,
// printer badge), never at rest. See DESIGN.md "Adult labels".
test("adult hint layer: empty at rest, outside kid screens, only from taps, short-lived", () => {
  const tags = html.match(/<div id="adultHint"[^>]*>([\s\S]*?)<\/div>/g) ?? [];
  assert.equal(tags.length, 1, "exactly one #adultHint layer");
  const m = tags[0].match(/<div id="adultHint"([^>]*)>([\s\S]*?)<\/div>/);
  assert.match(m[1], /\bhidden\b/, "#adultHint starts hidden");
  assert.match(m[1], /role="status"/, "#adultHint is announced (role=status)");
  assert.equal(m[2].trim(), "", "#adultHint is empty in the markup");
  for (const id of KID_SCREENS) assert.ok(!screen(id).includes('id="adultHint"'), `#adultHint is not inside #${id}`);
  // Words come from one allow-list (HINTS) or the printer label, nothing ad hoc.
  const script = html.slice(html.indexOf('<script type="module">'));
  const calls = [...script.matchAll(/showHint\(([^;]*?)\)\s*[;}]/g)].map((c) => c[1]).filter((a) => !/^anchor, text/.test(a));
  assert.ok(calls.length >= 3, "gear, make-another-booth and printer badge use showHint");
  for (const a of calls) assert.match(a, /,\s*(HINTS\.\w+|printerHint\(.*\)|hint)\s*(,\s*0)?\s*$/, `showHint text must be HINTS.* or printerHint(): showHint(${a})`);
  const holds = [...script.matchAll(/holdable\(\$\("\w+"\), \{([^}]*)\}/g)].map((h) => h[1]);
  assert.ok(holds.length >= 2, "gear + make-another-booth are press-and-hold");
  for (const h of holds) assert.match(h, /hint: HINTS\.\w+/, `holdable hint comes from HINTS: ${h}`);
  // Only from interaction: inside holdable() (pointer handlers) or an onclick handler, never on load or on a state change.
  const hold = script.slice(script.indexOf("function holdable("), script.indexOf("\n}\n", script.indexOf("function holdable(")));
  for (const line of script.split("\n").filter((l) => /showHint\(/.test(l) && !/function showHint/.test(l))) {
    assert.ok(hold.includes(line) || /\.onclick\s*=/.test(line), `showHint only from a tap/hold handler: ${line.trim()}`);
  }
  const ms = +(script.match(/const HINT_MS = (\d+);/) ?? [])[1];
  assert.ok(ms > 0 && ms <= 4000, `labels fade within 4 s (HINT_MS = ${ms})`);
  const css = SHEETS["index.html"].match(/#adultHint \{([^}]*)\}/)[1];
  assert.ok(!/animation:/.test(css), "#adultHint has no animation beyond its fade");
  assert.match(css, /pointer-events:none/, "#adultHint never blocks a kid's tap");
});

test("drawn icons paint only token colours", () => {
  const root = SHEETS["index.html"].match(/:root\s*\{([^}]*)\}/)[1];
  const tokens = new Set([...root.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toUpperCase()));
  const bad = [...icons.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toUpperCase()).filter((c) => !tokens.has(c));
  assert.deepEqual(bad, [], "icons.js colours outside the :root tokens");
  assert.ok(/<script[^>]*>[\s\S]*from "\.\/icons\.js"/.test(html), "index.html uses the shared icon module");
});

test("print art is ink only (#000 / #fff)", () => {
  const bad = frames.split("\n").map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => {
    if (line.includes("lint-allow:")) return false;
    const lits = [...line.matchAll(/(fillStyle|strokeStyle|shadowColor)\s*=\s*(["'`])([^"'`]+)\2/g)].map((m) => m[3]);
    const hex = [...line.matchAll(/["'`](#[0-9a-f]{3,8}|rgba?\([^)]*\))["'`]/gi)].map((m) => m[1]);
    return [...lits, ...hex].some((v) => !/^#(000|fff)$/i.test(v));
  });
  assert.equal(bad.length, 0, "non-ink print colours:\n" + bad.map((b) => `  frames.js:${b.n}: ${b.line.trim()}`).join("\n"));
});

test("no merge-conflict markers in shipped files", async () => {
  const { readdirSync } = await import("node:fs");
  const dir = new URL("../public/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => /\.(html|js|webmanifest)$/.test(n))) {
    const text = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/^(<{7}|={7}|>{7}|\|{7})( |$)/m.test(text), `conflict markers in public/${f}`);
  }
});
