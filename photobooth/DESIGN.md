# Booth design — "Thermal Arcade"

A candy-coloured arcade cabinet that spits out receipt-paper treasures.
It should feel like a **toy**, not an app. If a screen could ship in a banking app, it's wrong.

## Principles

1. **No words for kids.** Camera, review, printing and done screens use only
   emoji, shapes and numerals. Words live in `aria-label` and adult settings.
2. **Everything is a sticker.** Thick ink outline, hard offset shadow (no blur),
   slight tilt. Stack stickers so they overlap a little.
3. **Press = squish.** Buttons drop into their shadow when pressed
   (`.sticker:active`). Every tap makes a sound.
4. **Loud and quick motion.** Things pop, wiggle and bounce with
   `--ease-pop`. One-shot animations run ≤ 600 ms; only ambient loops run longer.
5. **Paper is the hero.** The preview is real receipt paper with torn zig-zag
   edges, and it feeds out of a printer drawn on screen.
6. **Prints are ink only, and light on solid black.** Strip art is pure
   `#000`/`#fff`: outlines, thin sunburst rays, halftone dots, zig-zags. Only
   photos have tones. Big solid blacks overheat the print head and leave grey
   haze on the paper after them, so prefer outlines to solid masses. No titles; the
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

## Print themes (`public/frames.js`)

Every strip has photos in fat outlined frames with a black shadow down their
right edge (never under them: black rows haze the paper that follows), zig-zag
torn edges at the top and bottom, and a perforated ticket stub with an outlined
`№042` and an outlined date pill. Each theme adds a header band with no text plus
scattered decorations: 🎞️ film · ⭐ sunburst · 💖 scallops · 🎉 bunting +
halftone · 🦖 footprints + grass · 🚀 orbits + starfield · 📷 bold (stub only).

## Lint

`npm run lint` (in `photobooth/`) enforces the rules a reviewer would catch:

- no raw colours outside `:root` (use tokens / `color-mix`)
- `box-shadow` only via `var(--shadow*)`
- `font-family` only via `var(--font-*)`
- kid screens have no Latin letters in visible text, and every kid `<button>` has an `aria-label`
- print art in `frames.js` only paints `#000` / `#fff`
- one-shot animations ≤ 600 ms (ambient loops listed in `AMBIENT`)
