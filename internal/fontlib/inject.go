package fontlib

import (
	"encoding/base64"
	"fmt"
	"os"
	"strings"
)

// InjectFont injects a @font-face + body override CSS block for slug into html.
// Font bytes are embedded as a base64 data URI to avoid file:// cross-origin
// restrictions in headless Chrome. Returns modified HTML or an error.
func InjectFont(html, slug, dataDir string) (string, error) {
	f, ok := Lookup(slug)
	if !ok {
		return "", fmt.Errorf("font %q not found; run: receiptd fonts list", slug)
	}
	if !IsInstalled(f, dataDir) {
		return "", fmt.Errorf("font %s not installed; run: receiptd fonts install %s", f.DisplayName, f.Slug)
	}

	data, err := os.ReadFile(FontPath(f, dataDir))
	if err != nil {
		return "", fmt.Errorf("read font: %w", err)
	}

	css := buildCSS(f, data)
	return injectCSS(html, css), nil
}

// buildCSS generates the @font-face + body override CSS, embedding the font as
// a base64 data URI so Chrome can load it regardless of file:// security policy.
func buildCSS(f Font, fontData []byte) string {
	encoded := base64.StdEncoding.EncodeToString(fontData)
	return fmt.Sprintf(`<style>
@font-face {
  font-family: '%s';
  src: url('data:%s;base64,%s') format('%s');
}
body {
  font-family: '%s', monospace;
  font-size: %dpx;
  -webkit-font-smoothing: none;
  font-smooth: never;
  text-rendering: optimizeSpeed;
}
</style>`, f.Family, FontMIME(f.Format), encoded, CSSFormatHint(f.Format), f.Family, f.DefaultSize)
}

// FontMIME returns the MIME type for a font format string.
func FontMIME(format string) string {
	switch strings.ToLower(format) {
	case "woff2":
		return "font/woff2"
	case "ttf":
		return "font/ttf"
	case "otf":
		return "font/otf"
	default:
		return "font/" + format
	}
}

// CSSFormatHint returns the CSS format() hint string for a font format.
func CSSFormatHint(format string) string {
	switch strings.ToLower(format) {
	case "ttf":
		return "truetype"
	case "otf":
		return "opentype"
	default:
		return format
	}
}

// injectCSS inserts the <style> block before </head>. If no </head> is found,
// prepends to the document.
func injectCSS(html, cssBlock string) string {
	if idx := strings.Index(strings.ToLower(html), "</head>"); idx != -1 {
		return html[:idx] + cssBlock + "\n" + html[idx:]
	}
	return cssBlock + "\n" + html
}
