package fontlib

import (
	"fmt"
	"strings"
)

// InjectFont injects a @font-face + body override CSS block for slug into html.
// Returns the modified HTML or an error if the font is not installed.
func InjectFont(html, slug, dataDir string) (string, error) {
	f, ok := Lookup(slug)
	if !ok {
		return "", fmt.Errorf("font %q not found; run: receiptd fonts list", slug)
	}
	if !IsInstalled(f, dataDir) {
		return "", fmt.Errorf("font %s not installed; run: receiptd fonts install %s", f.DisplayName, f.Slug)
	}

	fontPath := FontPath(f, dataDir)
	css := buildCSS(f, fontPath)

	return injectCSS(html, css), nil
}

// buildCSS generates the @font-face + body override CSS for a font.
func buildCSS(f Font, absPath string) string {
	return fmt.Sprintf(`<style>
@font-face {
  font-family: '%s';
  src: url('file://%s') format('%s');
}
body {
  font-family: '%s', monospace;
  font-size: %dpx;
  -webkit-font-smoothing: none;
  font-smooth: never;
  text-rendering: optimizeSpeed;
}
</style>`, f.Family, absPath, f.Format, f.Family, f.DefaultSize)
}

// injectCSS inserts the <style> block before </head>. If no </head> is found,
// prepends to the document.
func injectCSS(html, cssBlock string) string {
	if idx := strings.Index(strings.ToLower(html), "</head>"); idx != -1 {
		// Find the actual position in the original (case-preserved) string.
		// strings.ToLower preserves byte positions so idx is correct.
		return html[:idx] + cssBlock + "\n" + html[idx:]
	}
	// No <head> tag — prepend.
	return cssBlock + "\n" + html
}
