You are generating a receipt to print on a Star Micronics thermal receipt printer (80mm, 576px wide).

**Default approach: HTML via `--render`.** Renders through headless Chrome — emojis, CSS, web fonts, images all work.

## Workflow

```bash
# Preview first (always)
receiptd render --output /tmp/preview.png - <<'EOF'
<html>...</html>
EOF
open /tmp/preview.png

# Print when happy — reuse the saved render, no second Chrome launch:
receiptd renders print a3f2c [--dither floyd-steinberg]
# (use the short ID shown after render, or /tmp/preview.png if --output was set)
receiptd print --image /tmp/preview.png [--dither floyd-steinberg]
```

## Starter template

```html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Courier New', monospace;
  font-size: 20px;
  width: 100%;          /* fills the 384px CSS viewport */
  background: white;
  padding: 12px 14px;
  box-sizing: border-box;
}
.center { text-align: center; }
.right  { text-align: right; }
.rule   { border-top: 2px solid #000; margin: 8px 0; }
.rule.dashed { border-style: dashed; }
.row    { display: flex; justify-content: space-between; }
.big    { font-size: 36px; font-weight: bold; }
.small  { font-size: 15px; color: #444; }
</style></head><body>

  <p class="center big">🧾 RECEIPT</p>
  <p class="center small">Shop Name · 123 Main St</p>
  <div class="rule"></div>

  <div class="row"><span>Item one</span><span>$10.00</span></div>
  <div class="row"><span>Item two</span><span>$5.00</span></div>

  <div class="rule dashed"></div>
  <div class="row"><strong>Total</strong><strong>$15.00</strong></div>
  <div class="rule"></div>

  <p class="center">Thank you! 🙏</p>

</body></html>
```

## Layout rules

- **CSS viewport is 384px** (RenderScale=1.5 narrows it so content prints 1.5× larger). Use `body { width: 100% }` — don't hardcode 576px.
- **Height is unconstrained** — flows as long as needed.
- **No margins needed at bottom** — daemon appends feed + cut automatically.
- Emojis ✅, CSS ✅, flexbox ✅, `@import` web fonts ✅ (when network available).
- `font-size: 20px` ≈ normal receipt text. `36px`+ for headers.
- Monospace (Courier New) looks most receipt-like. System UI fonts also work.
- `border-top: 2px solid #000` for separator lines; `border-style: dashed` for dashed rules.

## Design fast

Preview → adjust → print. `open /tmp/preview.png` after each render to see the result before committing to paper. Use `--staged` if you want to inspect the job before the printer picks it up.

## When to use Star Markup instead

Use `/star-markup-print` for: text-only layouts, when Chrome is unavailable, or when precise column/tab alignment matters more than visual richness.
