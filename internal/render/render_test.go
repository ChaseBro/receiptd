package render

import (
	"flag"
	"image/png"
	"bytes"
	"os"
	"os/exec"
	"testing"
)

// fixtureHTML is a simple, stable receipt snippet used for both the dimension
// and snapshot tests. It avoids web fonts and external resources so Chrome
// renders it identically across runs on the same machine.
const fixtureHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: monospace; font-size: 14px; background: white; color: black; width: 100%; }
  .header { text-align: center; font-weight: bold; padding: 8px 0; border-bottom: 1px solid black; }
  .row { display: flex; justify-content: space-between; padding: 4px 8px; }
  .total { border-top: 1px solid black; font-weight: bold; }
  .footer { text-align: center; padding: 8px 0; font-size: 12px; }
</style>
</head>
<body>
  <div class="header">RECEIPT</div>
  <div class="row"><span>Widget A</span><span>$10.00</span></div>
  <div class="row"><span>Widget B</span><span>$5.00</span></div>
  <div class="row total"><span>TOTAL</span><span>$15.00</span></div>
  <div class="footer">Thank you!</div>
</body>
</html>`

var updateGolden = flag.Bool("update", false, "regenerate golden snapshot files")

// requireChrome skips t if Chrome or Chromium is not installed.
func requireChrome(t *testing.T) {
	t.Helper()
	knownPaths := []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	}
	for _, p := range knownPaths {
		if _, err := os.Stat(p); err == nil {
			return
		}
	}
	for _, name := range []string{"google-chrome", "chromium-browser", "chromium", "chrome"} {
		if _, err := exec.LookPath(name); err == nil {
			return
		}
	}
	t.Skip("Chrome or Chromium not found — skipping render tests (install Chrome to enable)")
}

// TestHTMLToPNGDimensions verifies that the rendered PNG is exactly PrinterWidth
// pixels wide, regardless of the RenderScale value.
func TestHTMLToPNGDimensions(t *testing.T) {
	requireChrome(t)

	data, err := HTMLToPNG(fixtureHTML, 0)
	if err != nil {
		t.Fatalf("HTMLToPNG: %v", err)
	}

	w, h, err := PNGDimensions(data)
	if err != nil {
		t.Fatalf("PNGDimensions: %v", err)
	}
	if w != PrinterWidth {
		t.Errorf("PNG width = %d, want %d (PrinterWidth)", w, PrinterWidth)
	}
	if h <= 0 {
		t.Errorf("PNG height = %d, want > 0", h)
	}
	t.Logf("rendered PNG: %dx%d px", w, h)
}

// TestHTMLToPNGSnapshot renders the fixture HTML and compares the result
// pixel-by-pixel against testdata/golden.png.
//
// If testdata/golden.png does not exist (or -update is passed), the current
// output is written as the new golden file and the test passes.
//
// On mismatch, testdata/actual.png is written alongside the golden so you can
// inspect the difference visually before deciding whether to accept it.
//
// To regenerate: go test ./internal/render/ -run TestHTMLToPNGSnapshot -update
func TestHTMLToPNGSnapshot(t *testing.T) {
	requireChrome(t)

	const goldenPath = "testdata/golden.png"
	const actualPath = "testdata/actual.png"

	data, err := HTMLToPNG(fixtureHTML, 0)
	if err != nil {
		t.Fatalf("HTMLToPNG: %v", err)
	}

	if *updateGolden {
		if err := os.WriteFile(goldenPath, data, 0644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("golden file updated: %s", goldenPath)
		return
	}

	golden, err := os.ReadFile(goldenPath)
	if err != nil {
		if os.IsNotExist(err) {
			// First run — create the golden file.
			if err := os.WriteFile(goldenPath, data, 0644); err != nil {
				t.Fatalf("write golden: %v", err)
			}
			t.Logf("golden file created: %s (run again to compare)", goldenPath)
			return
		}
		t.Fatalf("read golden: %v", err)
	}

	// Decode both PNGs and compare pixel-by-pixel.
	gotImg, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("decode actual PNG: %v", err)
	}
	wantImg, err := png.Decode(bytes.NewReader(golden))
	if err != nil {
		t.Fatalf("decode golden PNG: %v", err)
	}

	gb := gotImg.Bounds()
	wb := wantImg.Bounds()
	if gb != wb {
		_ = os.WriteFile(actualPath, data, 0644)
		t.Fatalf("PNG size mismatch: got %v, want %v (golden); actual written to %s", gb, wb, actualPath)
	}

	var diffPixels int
	for y := gb.Min.Y; y < gb.Max.Y; y++ {
		for x := gb.Min.X; x < gb.Max.X; x++ {
			gr, gg, gb2, ga := gotImg.At(x, y).RGBA()
			wr, wg, wb2, wa := wantImg.At(x, y).RGBA()
			if gr != wr || gg != wg || gb2 != wb2 || ga != wa {
				diffPixels++
			}
		}
	}

	if diffPixels > 0 {
		_ = os.WriteFile(actualPath, data, 0644)
		t.Errorf("snapshot mismatch: %d pixel(s) differ from golden; actual written to %s\n"+
			"To accept the new output, run: go test ./internal/render/ -run TestHTMLToPNGSnapshot -update",
			diffPixels, actualPath)
	}
}
