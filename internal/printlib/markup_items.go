package printlib

import (
	"fmt"
	"os"
	"strings"

	"github.com/ChaseBro/receiptd/internal/imageproc"
)

func init() {
	allItems = append(allItems,
		Item{
			Name:        "alignment",
			Description: "Left / center / right alignment demo",
			Kind:        KindTest,
			Mode:        ModeMarkup,
			Tags:        []string{"text", "layout"},
			MarkupFn:    markupAlignment,
		},
		Item{
			Name:        "typography",
			Description: "Bold, underline, magnification, negative, font B",
			Kind:        KindTest,
			Mode:        ModeMarkup,
			Tags:        []string{"text", "formatting"},
			MarkupFn:    markupTypography,
		},
		Item{
			Name:        "box-drawing",
			Description: "Single, double, and curved boxes using known-good chars",
			Kind:        KindTest,
			Mode:        ModeMarkup,
			Tags:        []string{"unicode", "boxes"},
			MarkupFn:    markupBoxDrawing,
		},
		Item{
			Name:        "block-elements",
			Description: "█ ▓ ▒ ░ ▀ ▄ ▌ ▐ ■ □ full showcase",
			Kind:        KindTest,
			Mode:        ModeMarkup,
			Tags:        []string{"unicode", "blocks"},
			MarkupFn:    markupBlockElements,
		},
		Item{
			Name:        "separators",
			Description: "─ solid, ═ double, mixed aesthetic separator variants",
			Kind:        KindPattern,
			Mode:        ModeMarkup,
			Tags:        []string{"layout", "dividers"},
			MarkupFn:    markupSeparators,
		},
		Item{
			Name:        "unicode",
			Description: "Curated one-page showcase of known-good Unicode on TSP100IV",
			Kind:        KindTest,
			Mode:        ModeMarkup,
			Tags:        []string{"unicode", "chars"},
			MarkupFn:    markupUnicode,
		},
		Item{
			Name:        "dither-compare",
			Description: "7 dither algorithms applied to gradient.png, stacked with labels",
			Kind:        KindTest,
			Mode:        ModeMarkup,
			Tags:        []string{"image", "dither"},
			MarkupFn:    markupDitherCompare,
		},
	)
}

func markupAlignment() string {
	sep := strings.Repeat("─", 48)
	return fmt.Sprintf(`[align: center][bold: on]ALIGNMENT TEST[bold: off]
%s
[align: left]Left-aligned text sits flush with the left margin.
%s
[align: center]Centered text is balanced on the paper.
%s
[align: right]Right-aligned text sits at the right edge.
%s
[align: left]Back to default left alignment.
[feed: 2]`, sep, sep, sep, sep)
}

func markupTypography() string {
	sep := strings.Repeat("─", 48)
	return fmt.Sprintf(`[align: center][bold: on]TYPOGRAPHY TEST[bold: off]
%s
[bold: on]Bold text is heavier and more prominent.[bold: off]
[underline: on]Underlined text has a line below.[underline: off]
[upperline: on]Upperlined text has a line above.[upperline: off]
%s
[mag: w 2; h 2]2× Wide + Tall[plain]
[mag: w 2]2× Wide only[plain]
[mag: h 2]2× Tall only[plain]
%s
[negative: on]Negative: white on black.[negative: off]
%s
[font: b]Font B is narrower — fits more chars per line. ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqr[font]
%s
[plain]All formatting reset by [plain].
[feed: 2]`, sep, sep, sep, sep, sep)
}

func markupBoxDrawing() string {
	sep := strings.Repeat("─", 48)
	return fmt.Sprintf(`[align: center][bold: on]BOX DRAWING TEST[bold: off]
%s
[align: left]Single-line box:
┌──────────────────────────────────────────────┐
│ Content inside a single-line bordered box.   │
│ Second line.                                 │
└──────────────────────────────────────────────┘
%s
Double-line box:
╔══════════════════════════════════════════════╗
║ Content inside a double-line bordered box.  ║
║ Second line.                                ║
╚══════════════════════════════════════════════╝
%s
Curved corners:
╭──────────────────────────────────────────────╮
│ Content inside a curved-corner box.          │
│ Second line.                                 │
╰──────────────────────────────────────────────╯
%s
T-junctions and cross:
├──────────────────────────────────────────────┤
┬ top  ┼ cross  ┴ bottom
╠══════════════════════════════════════════════╣
[feed: 2]`, sep, sep, sep, sep)
}

func markupBlockElements() string {
	sep := strings.Repeat("─", 48)
	return fmt.Sprintf(`[align: center][bold: on]BLOCK ELEMENTS[bold: off]
%s
[align: left]Solid fills (darkest → lightest):
████████████████████████████████████████████████
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
%s
Half-blocks: ▀ upper  ▄ lower  ▌ left  ▐ right
Squares:     ■ filled  □ outline
%s
Gradient demo using block elements:
████████████████▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒░░░░░░░░
[feed: 2]`, sep, sep, sep)
}

func markupSeparators() string {
	return `[align: center][bold: on]SEPARATOR PATTERNS[bold: off]
[align: left]
Solid single (─ U+2500, 48×):
────────────────────────────────────────────────

Double (═ U+2550, 46× with corners):
╔══════════════════════════════════════════════╗
╚══════════════════════════════════════════════╝

Thick solid block:
████████████████████████████████████████████████

Light fill:
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

Mixed: solid / space / solid:
────────────────────  ────────────────────

Dashed (hyphens, note: less crisp):
- - - - - - - - - - - - - - - - - - - - - - - -

Stars:
* * * * * * * * * * * * * * * * * * * * * * * *
[feed: 2]`
}

func markupUnicode() string {
	sep := strings.Repeat("─", 48)
	return fmt.Sprintf(`[align: center][bold: on]UNICODE SHOWCASE[bold: off]
%s
[align: left]Latin Extended:
à á â ä å æ ç è é ê ë ì í î ï ñ ò ó ô ö ù ú û ü ý ß ø
%s
Greek: α β γ δ ε ζ η θ ι κ λ μ ν ξ ο π ρ σ τ υ φ χ ψ ω
Cyrillic: А Б В Г Д Е Ж З И К Л М Н О П Р С Т У Ф Х
%s
Arrows: → ← ↑ ↓ ↔ ↕ ⇒ ⇔
Geometric: ● ○ ◆ ◇ ▲ ▼ ◀ ▶ ► ★ ☆
Cards/Music: ♠ ♣ ♥ ♦ ♩ ♪ ♫ ♬
%s
Math: ± × ÷ ≤ ≥ ≠ ≈ ∞ √ ∑ ∏ ∂ ∫ ∆ ∇ ∈ ∉ ⊂ ⊃
Currency: € £ ¥ ¢  Fractions: ½ ¼ ¾ ⅓ ⅔
%s
Misc: © ® ™ ° § ¶ † ‡ • … ‰ ′ ″ ℃ ℉ № ℡ ☎
Superscript: ¹ ² ³
[feed: 2]`, sep, sep, sep, sep, sep)
}

var ditherAlgorithms = []struct {
	alg   imageproc.Algorithm
	label string
}{
	{imageproc.None, "none (raw)"},
	{imageproc.Threshold, "threshold"},
	{imageproc.FloydSteinberg, "floyd-steinberg"},
	{imageproc.Atkinson, "atkinson"},
	{imageproc.Bayer, "bayer"},
	{imageproc.Hilbert, "hilbert"},
	{imageproc.BlueNoise, "blue-noise"},
}

func markupDitherCompare() string {
	gradientPath, err := ImageAsset("gradient.png")
	if err != nil {
		return fmt.Sprintf("[align: center]Error loading gradient: %s\n[feed: 2]", err)
	}
	defer os.Remove(gradientPath)

	raw, err := os.ReadFile(gradientPath)
	if err != nil {
		return fmt.Sprintf("[align: center]Error reading gradient: %s\n[feed: 2]", err)
	}

	sep := strings.Repeat("─", 48)
	var sb strings.Builder
	sb.WriteString("[align: center][bold: on]DITHER ALGORITHM COMPARISON[bold: off]\n")
	sb.WriteString(sep + "\n")
	sb.WriteString("[align: left]576×200 grayscale ramp — black → white\n")
	sb.WriteString(sep + "\n")

	for _, entry := range ditherAlgorithms {
		var processed []byte
		if entry.alg == imageproc.None {
			processed = raw
		} else {
			processed, err = imageproc.Process(raw, imageproc.Options{Algorithm: entry.alg})
			if err != nil {
				sb.WriteString(fmt.Sprintf("[bold: on]%s[bold: off] — error: %s\n", entry.label, err))
				continue
			}
		}

		tmp, err := os.CreateTemp("", "receiptd-dither-*.png")
		if err != nil {
			sb.WriteString(fmt.Sprintf("[bold: on]%s[bold: off] — temp error: %s\n", entry.label, err))
			continue
		}
		tmp.Write(processed)
		tmp.Close()

		sb.WriteString(fmt.Sprintf("[bold: on]%s[bold: off]\n", entry.label))
		sb.WriteString(fmt.Sprintf("[image: url file://%s; width 100%%]\n", tmp.Name()))
		sb.WriteString(sep + "\n")
	}

	sb.WriteString("[feed: 2]")
	return sb.String()
}
