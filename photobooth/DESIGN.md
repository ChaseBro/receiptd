# Booth design — "Thermal Arcade"

A candy-coloured arcade cabinet that spits out receipt-paper treasures.
It should feel like a **toy**, not an app. If a screen could ship in a banking app, it's wrong.

## Principles

1. **No words for kids.** Camera, review, printing and done screens use only
   drawn icons (or Classic emoji), shapes and numerals. Words live in
   `aria-label`, adult settings, and the adult label layer (below), which is
   empty at rest.
2. **Everything is a sticker.** Thick ink outline, hard offset shadow (no blur),
   slight tilt. Stack stickers so they overlap a little.
3. **Press = squish.** Buttons drop into their shadow when pressed
   (`.sticker:active`). Every tap makes a sound.
4. **Loud and quick motion.** Things pop, wiggle and bounce with
   `--ease-pop`. One-shot animations run ≤ 600 ms; only ambient loops run longer.
5. **Paper is the hero.** The preview is real receipt paper with torn zig-zag
   edges, and it feeds out of a printer drawn on screen. The guest pages (`/s/`,
   the album, its slideshow, the archive) lead with the printed receipt too: the
   exact 1-bit strip, never smoothed, on the same torn paper with an ink shadow
   and a tilt; the colour photos come second.
6. **Prints are ink only.** Strip art is pure `#000`/`#fff`: offset blocks,
   sunbursts, halftone dots, zig-zags. Only photos have tones. No titles; the
   ticket stub (number + date) is the only type on paper.

## Tokens (`:root` in `public/index.html`)

| token | value | use |
|---|---|---|
| `--paper` | `#FFF4DC` | backgrounds (receipt cream) |
| `--ink` | `#1A1423` | outlines, shadows, text |
| `--pink` `--sun` `--mint` `--sky` `--grape` `--tomato` | candy set | accents; each theme picks `--accent` + `--accent-2` |
| `--line` | `4px` (`--line-fat` 6px) | sticker outlines |
| `--shadow` | `6px 6px 0 var(--ink)` (`-sm`, `-lg`) | the only allowed shadows |
| `--r` | `24px` | card radius; pills/circles use `999px`/`50%` |
| `--font-display` | Lilita One (self-hosted, OFL) | numerals, headings, ticket stub |
| `--font-body` | `ui-rounded` stack | adult settings |
| `--font-emoji` | Apple/Segoe/Noto emoji | all emoji |
| `--ease-pop` | `cubic-bezier(.34,1.56,.64,1)` | entrances, presses |

Tap targets for kids are at least **72px**, and the shutter is at least **140px**.

## Drawn icons (`public/icons.js`, `ios/App/Icons.swift`)

Every UI icon on the kid screens is a drawn sticker from one shared module:
inline SVG in a 100×100 box, thick ink outline, a hard 4-unit ink shadow
(an SVG filter, no blur), candy fills, Lilita numerals. iOS mirrors the same
geometry function by function in SwiftUI `Canvas`. Source of truth: the
approved booth sketch. Settings → **Icon style: Drawn / Classic** (Classic =
the emoji the booth used before). Theme-picker icons stay emoji.

The set: shutter, flip, 1 / 3 photos, no camera, gear, share the booth
(phone +), share this photo (strip + arrow), waiting, in line #N, retake,
print, rotate, copies / minus / plus, try again, back (an arrow, no longer ✖️),
done, and the printer: ready, printing, offline (sleeping, unplugged from the
wall; simplified to read at 44 px), out of paper (empty dashed roll), cover
open (lid up), error (X eyes + smoke), paper low (settings only).

## Grown-up controls on kid screens

- **Gear** (settings): a small white sticker in the camera window's top-right
  corner. **Share the booth** (let guests use their own phones as booths too):
  the same small white sticker, *off* the camera window, at the end of the theme
  bar (portrait: top right of the screen; landscape: bottom of the theme
  column), clear of the themes' scroll, the gear, the tray and the printer
  badge. Both 44 px on phones, ~60 px on iPads. **Press and hold
  1.2 s**: a grape ring fills, "Keep holding…" shows beside it, a haptic tick at
  50 % and a pop at full. Let go early and the ring drains. A short tap shows
  "Hold to open settings" / "Hold to share the booth" and wiggles.
- **Printer badge**: a sun sticker, bottom-left of the camera, with a slow
  wiggle, only when the printer needs a grown-up (offline, out of paper, cover
  open, error), one drawing each. A tap shows one line: "Printer offline · last
  seen 2:14 pm · Check its power & Wi-Fi", "Out of paper", "Cover open",
  "Printer error — turn it off and on".
  A napping printer (stale check-in, no error; the booth is nudging it) gets the
  quiet version: the same sun, smaller, still, see-through, a sleeping printer
  with no plug and no "!" ("Printer napping · waking it up…"); it only turns
  into offline if the nudge goes unanswered.

### Adult labels (the one way words reach a kid screen)

One quiet pill (`#adultHint` on the web, `AdultHint` on iOS), shown **only in
answer to an adult's tap or hold on one of those three controls**: never on
load, never because a state changed, never auto-cycling. One at a time (a new
one replaces the old), a short fade only, gone after ~2.5 s or on any other
touch. Not on flip / mode or other kid controls. The strings live in one place
(`HINTS` + `printerHint()`).

### First-run coach (teach "tap the camera, then print")

Once per device, until its first print goes out (a device that has printed before never sees it):
a soft spotlight on the one control to tap and the drawn pointing hand (`point`; Classic 👆)
poking at it: the shutter on the camera screen, then Print on review. "Share this photo" is never
coached. No words, not even the adult label: the hand is enough. Taps go straight through;
tapping the highlighted control moves on, any other tap skips it for the visit. It is gone during
the countdown and flash. Settings → Booth → "Show the how-to again" brings it back (lint: "first-run
coach").

## Print themes (`public/frames.js`)

Every strip has photos in fat outlined frames with a black offset block behind
them and a perforated ticket stub with `№ 042` and the date. The printed paper
has clean edges: no torn zig-zag rows at the top or bottom (the printer's own
cut is the edge; torn edges are an on-screen paper treatment only). Each theme adds a header band with no text plus
scattered decorations: 🎞️ film · ⭐ sunburst · 💖 scallops · 🎉 bunting +
halftone · 🦖 footprints + grass · 🚀 orbits + starfield · 📷 bold (stub only).

## Lint

`npm run lint` (in `photobooth/`) enforces the rules a reviewer would catch:

- no raw colours outside `:root` (use tokens / `color-mix`)
- `box-shadow` only via `var(--shadow*)`
- `font-family` only via `var(--font-*)`
- kid screens have no Latin letters in visible text, and every kid `<button>` has an `aria-label`
- **adult hint layer**: exactly one `#adultHint`, `hidden`, empty in the markup, `role="status"`, outside
  every kid screen; `showHint()` text comes only from `HINTS.*` or `printerHint()`; it is called only from
  `holdable()`'s pointer handlers or an `onclick` (never on load / state change); `HINT_MS` ≤ 4 s; its CSS
  has no animation (fade only) and `pointer-events:none`. This is how the "no words" rule allows labels
  without being weakened: words may appear only through this layer, only on interaction.
- drawn icons (`icons.js`) paint only the `:root` token colours
- print art in `frames.js` only paints `#000` / `#fff`
- one-shot animations ≤ 600 ms (ambient loops listed in `AMBIENT`)
- the colour / shadow / font / motion rules also cover the adult `gallery.html`
