package render

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/chromedp/chromedp"
)

// PrinterWidth is the canonical viewport width for the Star TSP100IV (80mm paper).
const PrinterWidth = 576

// HTMLToPNG renders html to a full-page PNG at the given viewport width.
// width <= 0 defaults to PrinterWidth.
// Returns the raw PNG bytes, or an error if Chrome is not available or rendering fails.
func HTMLToPNG(html string, width int) ([]byte, error) {
	if width <= 0 {
		width = PrinterWidth
	}

	// Write HTML to a temp file so Chrome can load it via file:// (avoids data: URL length limits).
	tmp, err := os.CreateTemp("", "receiptd-render-*.html")
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}
	defer os.Remove(tmp.Name())

	if _, err := tmp.WriteString(html); err != nil {
		tmp.Close()
		return nil, fmt.Errorf("write html: %w", err)
	}
	tmp.Close()

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(),
		chromedp.Headless,
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.WindowSize(width, 1200),
		chromedp.Flag("hide-scrollbars", true),
	)
	defer cancelAlloc()

	ctx, cancelCtx := chromedp.NewContext(allocCtx)
	defer cancelCtx()

	ctx, cancelTimeout := context.WithTimeout(ctx, 30*time.Second)
	defer cancelTimeout()

	fileURL := "file://" + filepath.ToSlash(tmp.Name())

	var buf []byte
	if err := chromedp.Run(ctx,
		// Set viewport to exact printer width so layout matches paper.
		chromedp.EmulateViewport(int64(width), 1200),
		chromedp.Navigate(fileURL),
		// Full-page PNG (quality=100 selects PNG in chromedp).
		chromedp.FullScreenshot(&buf, 100),
	); err != nil {
		return nil, fmt.Errorf("render: %w", err)
	}

	return buf, nil
}

// SaveRender saves png bytes to <dataDir>/renders/<timestamp>.png and returns the path.
func SaveRender(dataDir string, png []byte) (string, error) {
	dir := filepath.Join(dataDir, "renders")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("create renders dir: %w", err)
	}
	name := fmt.Sprintf("render-%d.png", time.Now().UnixNano())
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, png, 0644); err != nil {
		return "", fmt.Errorf("write render: %w", err)
	}
	return path, nil
}

// DataDir returns the default receiptd data directory (~/.receiptd).
func DataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".receiptd"
	}
	return filepath.Join(home, ".receiptd")
}
