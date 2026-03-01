package fontlib_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ChaseBro/receiptd/internal/fontlib"
)

// stubFontFile creates a minimal font file in a temp fonts dir so InjectFont
// can find it without a real download. Supports woff2 and ttf/otf magic bytes.
func stubFontFile(t *testing.T, dataDir, fileName string) {
	t.Helper()
	dir := filepath.Join(dataDir, "fonts")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	var magic []byte
	switch {
	case strings.HasSuffix(fileName, ".woff2"):
		// WOFF2 magic: 0x774F4632
		magic = []byte{0x77, 0x4F, 0x46, 0x32, 0x00, 0x00, 0x00, 0x00}
	default:
		// TTF magic: 0x00010000
		magic = []byte{0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}
	}
	if err := os.WriteFile(filepath.Join(dir, fileName), magic, 0644); err != nil {
		t.Fatalf("write stub font: %v", err)
	}
}

func TestInjectFont_NotFound(t *testing.T) {
	tmpDir := t.TempDir()
	_, err := fontlib.InjectFont("<html></html>", "no-such-font", tmpDir)
	if err == nil {
		t.Fatal("expected error for unknown font slug, got nil")
	}
}

func TestInjectFont_NotInstalled(t *testing.T) {
	tmpDir := t.TempDir()
	_, err := fontlib.InjectFont("<html></html>", "press-start-2p", tmpDir)
	if err == nil {
		t.Fatal("expected error for uninstalled font, got nil")
	}
	if !strings.Contains(err.Error(), "not installed") {
		t.Errorf("error %q does not mention 'not installed'", err.Error())
	}
	if !strings.Contains(err.Error(), "receiptd fonts install") {
		t.Errorf("error %q does not mention install command", err.Error())
	}
}

func TestInjectFont_InjectsBeforeHead(t *testing.T) {
	tmpDir := t.TempDir()

	f, ok := fontlib.Lookup("press-start-2p")
	if !ok {
		t.Fatal("press-start-2p not in registry")
	}
	stubFontFile(t, tmpDir, f.FileName)

	html := `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
</head>
<body>Hello</body>
</html>`

	result, err := fontlib.InjectFont(html, "press-start-2p", tmpDir)
	if err != nil {
		t.Fatalf("InjectFont error: %v", err)
	}

	if !strings.Contains(result, "@font-face") {
		t.Error("result missing @font-face")
	}
	if !strings.Contains(result, f.Family) {
		t.Errorf("result missing font family %q", f.Family)
	}
	if !strings.Contains(result, "-webkit-font-smoothing: none") {
		t.Error("result missing anti-aliasing suppression")
	}
	if !strings.Contains(result, "file://") {
		t.Error("result missing file:// URL for font")
	}

	// The <style> block must appear before </head>
	styleIdx := strings.Index(result, "<style>")
	headCloseIdx := strings.Index(result, "</head>")
	if styleIdx == -1 {
		t.Fatal("result missing <style> tag")
	}
	if styleIdx > headCloseIdx {
		t.Errorf("<style> (pos %d) appears after </head> (pos %d)", styleIdx, headCloseIdx)
	}
}

func TestInjectFont_NoHeadTag(t *testing.T) {
	tmpDir := t.TempDir()

	f, ok := fontlib.Lookup("press-start-2p")
	if !ok {
		t.Fatal("press-start-2p not in registry")
	}
	stubFontFile(t, tmpDir, f.FileName)

	// HTML with no <head> tag
	html := `<body>Hello</body>`
	result, err := fontlib.InjectFont(html, "press-start-2p", tmpDir)
	if err != nil {
		t.Fatalf("InjectFont error: %v", err)
	}
	if !strings.HasPrefix(result, "<style>") {
		t.Error("expected <style> to be prepended when no <head> tag")
	}
}

func TestInjectFont_DefaultSizeUsed(t *testing.T) {
	tmpDir := t.TempDir()

	f, ok := fontlib.Lookup("press-start-2p")
	if !ok {
		t.Fatal("press-start-2p not in registry")
	}
	stubFontFile(t, tmpDir, f.FileName)

	result, err := fontlib.InjectFont("<html><head></head><body></body></html>", "press-start-2p", tmpDir)
	if err != nil {
		t.Fatalf("InjectFont error: %v", err)
	}

	expected := strings.TrimRight(strings.TrimLeft(
		strings.ReplaceAll(
			strings.ReplaceAll(result, "\n", " "),
			"  ", " "),
		" "), " ")
	_ = expected

	sizeStr := strings.Contains(result, "font-size:")
	if !sizeStr {
		t.Error("result missing font-size declaration")
	}
}
