# Star Document Markup — Full Reference

For receipt printing on Star TSP100IV (80mm, 48 chars/line normal, 24 chars at 2× magnify).

Official docs:
- Spec: https://star-m.jp/products/s_print/sdk/StarDocumentMarkup/manual/en/spec.html
- Tag index: https://star-m.jp/products/s_print/sdk/StarDocumentMarkup/manual/en/tag-reference/index.html

---

## Syntax

```
[<tag>: <param> <value>; <param> <value>]
```

- Tag followed by `:`, then space-separated `param value` pairs separated by `;`
- A `:` after a param name is optional (readability only): `[col: left: Soup; right: £4.50]`
- Spaces before a param name are ignored
- Tags without params omit the colon: `[cut]`, `[feed]`, `[plain]`
- Tags used without params **reset to defaults**: `[mag]`, `[align]`, `[bold]`, `[font]`, `[linespacing]`

### Escaping

| Escape | Output |
|--------|--------|
| `\[` | `[` |
| `\]` | `]` |
| `\\` | `\` |
| `\ ` (backslash + space) | non-breaking space — word content, not a delimiter |
| `\` at end of line | suppress line break — joins lines for word-wrap |

Word-wrap collapses ordinary spaces like HTML. Use `\ ` or `[sp]` when spaces must be preserved as content.

---

## Shorthands

| Full | Short |
|------|-------|
| `[column]` | `[col]`, `[2col]`, `[two-column]` |
| `[fixedWidth]` | `[fw]` |
| `[magnify]` | `[mag]` |
| `[space]` | `[sp]` |
| `width` (in magnify) | `w` |
| `height` (in magnify) | `h` |
| `variable-left` (in column) | `vl` |
| `black-mark` (in feed) | `bm` |
| `width` (in image) | `w` |
| `ellipsize-type` (in fixedWidth) | `et` |
| `width-type` (in fixedWidth) | `wt` |
| `count` (in space) | `c` |

---

## Tags

### Text formatting

```
[bold: on] / [bold: off] / [bold]          bold on / off / reset (=off)
[underline: on] / [underline: off]         underline
[upperline: on] / [upperline: off]         line above text
[font: b] / [font: a] / [font]             Font B (narrower) / A (default) / reset
[mag: w 2; h 2]                            scale 1–4 per axis; [mag] = reset to 1×1
[negative: on] / [negative: off]           white-on-black
[invert: on] / [invert: off] / [invert]   upside-down (whole line); must be at line start
[plain]                                    reset ALL: font, mag, bold, underline, upperline,
                                           negative, invert
```

Notes:
- Selecting a new font also resets magnification to 1×1
- Font B is narrower — more chars per line, less readable
- Mixing fonts/magnifications within a line works; word-wrap accounts for it
- `[invert]` affects the entire line it starts on

### Alignment & spacing

```
[align: center] / left / right / middle    [align] = left (default)
[linespacing: min] / [linespacing]         tight line spacing / reset to printer default
[sp: c 3]                                  insert 3 non-breaking spaces
```

### Column layout — [column] / [col]

| Param | Effect |
|-------|--------|
| `left TEXT` | left-column content |
| `right TEXT` | right-column content |
| `short TEXT` | fallback for `left` if full text won't fit |
| `vl` (variable-left) | drop `left` text entirely if line is too narrow |
| `indent 5mm` | set left margin (dots, mm, or %); persists across rows |
| `indent -20mm` | indent measured from right edge |

`[col]` with no params resets indent.

If neither `short` nor `vl` is set and columns don't fit, falls back to a stacked two-line layout.

```
[col: left Item; right £4.50]
[col: left Long Description; short Short; right £9.99]
[col: left Very Long Name; vl; right £2.00]
[col: indent 5mm]\
[col: left Indented row; right £1.00]
[col]\
[col: left Back to normal; right £3.00]
```

### Fixed-width fields — [fixedWidth] / [fw]

Clips (and optionally pads) `text` to exactly `width` half-width characters.

| Param | Effect |
|-------|--------|
| `text TEXT` | required — the content |
| `width N` | clip/pad to N chars; omit to fill to right edge |
| `align right` / `left` | justify within field (default: left) |
| `et end` | truncate with `…`; `et none` = hard cut (default) |
| `wt full` / `half` | count full-width or half-width chars (default: half) |

**Inline column pattern** — chain `[fw]` tags for fixed-width grids without `[column]`:

```
[fw: text ITEM NAME; width 36][fw: text £9.99; width 12; align right]
[fw: text Long item truncated here; width 36; et end][fw: text £99.99; width 12; align right]
```

36 + 12 = 48 chars: label flush-left, price flush-right.

**Right-justified single line:**
```
[fw: text THANK YOU; width 48; align right]
```

### Feed & paper

```
[feed]                     single line feed
[feed: length 10mm]        exact feed — dots, mm, or % of print width
[feed: tearbar]            feed to tearbar / cutter position
[feed: black-mark] / [feed: bm]   feed to next black mark
[feed: form]               form feed
[cut]                      full paper cut
[cut: feed; partial]       feed then partial cut
```

receiptd daemon auto-appends `[feed:3][cut]` — **do not include `[cut]` in job content**.

### Images

```
[image: url https://example.com/logo.png; width 60%; min-width 48mm]
[image: url file:///abs/path/to/image.png; width 80%]
[image: url "data:image/png;base64,<data>"; width 90%]
```

| Param | Effect |
|-------|--------|
| `url TEXT` | required — http/https, file://, or data: URL |
| `width N` | resize to N (dots, mm, or %) |
| `min-width N` | floor for scaling — prevents images becoming too small on 58mm paper |

Without `width`, prints dot-for-dot. Aspect ratio always preserved.
Images auto-advance to next line — use `\` immediately after to suppress extra line break:

```
[image: url file:///path/logo.png; width 80%]\
Text immediately after the image
```

**AI image generation prompt:**
> Black and white only, pure #000000 and #FFFFFF, no greys, no gradients. High contrast bold shapes. Simple composition. Designed for thermal receipt printer output. 580×464 pixels.

### Barcodes

```
[barcode: type code39; data 123456789; height 15mm; hri]
[barcode: type qrcode; data https://example.com]
```

Common types: `code39`, `code128`, `ean13`, `ean8`, `upca`, `qrcode`, `pdf417`

### Misc

```
[logo: number 1]           print stored logo slot
[buzzer]                   trigger buzzer
[drawer]                   open cash drawer
[comment: text]            ignored; [: text] also works
```

### Template printing

Separates layout (markup) from content (JSON). Use `${field}` placeholders:

```
[templateArray: start]
[col: left ${item.name}; right ${item.price}]
[templateArray: end]\
[cut]
```

Requires CPUtil v1.2.0+.

---

## Size units

| Format | Example | Meaning |
|--------|---------|---------|
| Dots | `width 300` | Printer dots — not portable across resolutions |
| Millimeters | `width 40mm` | Physical size — resolution-independent |
| Percentage | `width 60%` | Relative to printable width |

Combine: `[image: url …; width 60%; min-width 48mm]` — 60% but never narrower than 48mm.

---

## Unicode — what works on Star TSP100IV

| Category | Characters |
|---|---|
| Box drawing (single) | `─ │ ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼` |
| Box drawing (double) | `═ ║ ╔ ╗ ╚ ╝ ╠ ╣ ╬` |
| Box drawing (curved) | `╭ ╮ ╯ ╰` |
| Block fill | `█ ▓ ▒ ░ ▀ ▄ ▌ ▐ ■ □` |
| Geometric | `● ○ ◆ ◇ ▲ ▼ ◀ ▶ ► ★ ☆` |
| Arrows | `→ ← ↑ ↓ ↔ ↕ ⇒ ⇔` |
| Card suits | `♠ ♣ ♥ ♦` |
| Music | `♩ ♪ ♫ ♬` |
| Math | `± × ÷ ≤ ≥ ≠ ≈ ∞ √ ∑ ∏ ∂ ∫ ∆ ∇ ∈ ∉ ⊂ ⊃` |
| Currency | `€ £ ¥ ¢` |
| Fractions | `½ ¼ ¾ ⅓ ⅔` |
| Superscript | `¹ ² ³` only |
| Misc | `© ® ™ ° § ¶ † ‡ • … ‰ ′ ″ ℃ ℉ № ℡ ☎` |
| Latin Extended | virtually all accented chars: `à á â ä å æ ç è é ê ë ì í î ï ñ ò ó ô ö ù ú û ü ý ß ø` |
| Greek | full alphabet: `α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω Α–Ω` |
| Cyrillic | full alphabet: `А Б В Г Д Е Ж З И К Л М Н О П Р С Т У Ф Х Ц Ч Ш Щ Ъ Ы Ь Э Ю Я а–я` |

**Does NOT work:** emoji, dingbats (✓ ✗ ✈ ✉ ✎ ✏), most fancy arrows (⇐ ⇑ ⇓ ➜ ➡ ➤), non-ASCII currency (₿ ₹ ₩ ₽ ฿ ₺), weather (☀ ☁ ☂ ☃), superscripts ⁴⁺, subscripts, uncommon fractions (⅛ ⅜ ⅝ ⅞), box extension chars (╵ ╶ ╷), block elements (▪ ▫ ▬ ▭ ▮).

**Separator line:** Use `────────────────────────────────────────────────` (48× `─`, U+2500). Never use `-` (renders dotted) or `=`.

---

## ASCII art

### Character rendering on thermal paper

**Bold / visible — use for structure:**
```
= * # | / \ O o 0 @ M W H 8
```

**Medium — texture, fill, detail:**
```
+ ~ ^ _ ( ) [ ] { } < > I l i
```

**Thin / barely visible — texture only, not outlines:**
```
- . , ' " ` ;
```

**Shading palette (light → dark):**
```
. , : ; ` ~    (lightest)
- _ ( ) [ ] |
i l o a n
I H A U V T Y
W M 8 # @      (darkest)
```

`█ ▓ ▒ ░` extend this into solid fills — mix with ASCII art for shading effects.

### Width rules

- Normal: **48 chars per line**
- `[mag: w 2]`: **24 chars per line**
- `[mag: w 3]`: **16 chars per line**
- Always wrap ASCII art with `[align: center]`

### Spacing in ASCII art

Word-wrap collapses multiple spaces. Options for precise spacing:

**`\ ` escaped spaces** — each `\ ` is a non-breaking space, preserved as content:
```
[align: center]
\ \ \ /\
\ \ /\ \ \
```

**`[sp: c N]`** — insert exactly N non-breaking spaces inline:
```
[align: center]
[sp: c 6]/\[sp: c 6]
```

**`[fw]` for multi-column art** — wrap each block in a fixed-width field:
```
[fw: text  /\ ; width 24; align right][fw: text  /\ ; width 24]
```

### Row technique

Build shapes row by row. Every line should connect — no large gaps in outlines. Use bold chars (`|`, `/`, `\`, `*`, `=`) for structure. Reserve thin chars (`.`, `,`, `'`) for texture and anti-aliasing only. Shape correctness matters more than detail.

### Patterns

**Globe:**
```
    /=======\
   /  * o *  \
  |  o  |  o  |
  |  *  |  *  |
   \  o | o  /
    \=======/
```

**Rocket:**
```
     /\
    /  \
   | ** |
   |    |
   |    |
  /|    |\
 / +----+ \
   |    |
   | || |
```

**Heart:**
```
 ***   ***
*****V*****
 *********
  *******
   *****
    ***
     *
```

**Star:**
```
    *
   ***
  *****
 *******
*********
 *******
  *****
   ***
    *
```

**Bot / face:**
```
 /=========\
 |  O   O  |
 |    ^    |
 |  \___/  |
 \=========/
```

---

## Receipt layout patterns

**Bold header + body:**
```
[align: center][mag: w 2; h 2][bold: on]TITLE[plain]
────────────────────────────────────────────────
Body text, left-aligned, normal size.
[feed: 2]
```

**Itemised receipt:**
```
[align: center][bold: on]RECEIPT[bold: off]
────────────────────────────────────────────────
[col: left Large Vegetable Soup; right £4.50]
[col: left Garlic Bread; right £3.00]
[col: left Olives; right £1.50]
────────────────────────────────────────────────
[col: left TOTAL; right £9.00]
[feed: 2]
```

**Fixed-width itemised (precise alignment):**
```
[fw: text Item; width 36][fw: text Price; width 12; align right]
────────────────────────────────────────────────
[fw: text Large Vegetable Soup; width 36; et end][fw: text £4.50; width 12; align right]
[fw: text Garlic Bread; width 36][fw: text £3.00; width 12; align right]
────────────────────────────────────────────────
[fw: text TOTAL; width 36][fw: text £9.00; width 12; align right]
[feed: 2]
```

**Celebration / notification:**
```
[align: center][bold: on]PR MERGED[bold: off]
────────────────────────────────────────────────
[col: left Repo; vl; right myorg/myapp]
[col: left PR; vl; right #42 Fix login bug]
[col: left Author; vl; right chase]
────────────────────────────────────────────────
[align: center]
   /\
  /  \
 | ** |
  \  /
   \/
ship it!
[feed: 2]
```

**Double-line box:**
```
[align: center]
╔══════════════════════════════════════════════╗
║[sp: c 16]SPECIAL OFFER[sp: c 17]║
╠══════════════════════════════════════════════╣
║[sp: c 4]50% off all items today only[sp: c 4]║
╚══════════════════════════════════════════════╝
[feed: 2]
```

---

## Tips

- Always end content with `[feed: 2]` — paper has a fixed top margin from the tear point; `[feed: 2]` adds matching bottom padding. Daemon then adds `[feed:3][cut]`.
- `[negative: on]` + text = striking inverted header block
- `[linespacing: min]` before multi-line ASCII art tightens rows; reset with `[linespacing]` after
- `[font: b]` before dense data tables fits more columns; `[font]` to restore
- `\ ` at end-of-line joins lines — use to inline tags without inserting line breaks
