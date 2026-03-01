package render

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"time"

	"github.com/ChaseBro/receiptd/internal/shortid"
	"github.com/chromedp/chromedp"
)

// PrinterWidth is the physical output width in pixels (80mm paper at 203 DPI ≈ 576px).
const PrinterWidth = 576

// RenderScale controls content size on the printed receipt.
// The CSS viewport is narrowed by this factor so elements occupy RenderScale×
// more of the paper when the image is printed at full width.
// 1.5 makes a 20px font ≈ 4mm tall on paper instead of ~2.8mm.
const RenderScale = 1.5

// CSSPrinterWidth is the CSS viewport width for HTML templates.
// Use width: 100% or this value for body/container width.
const CSSPrinterWidth = int(PrinterWidth / RenderScale) // 384

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

	// Narrow the CSS viewport by RenderScale so that content fills proportionally
	// more of the paper when the image is printed at full width (width 100%).
	cssWidth := int(math.Round(float64(width) / RenderScale))

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(),
		chromedp.Headless,
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		// Window size matches physical pixels (cssWidth × RenderScale = width).
		chromedp.WindowSize(width, 1),
		chromedp.Flag("hide-scrollbars", true),
		// Suppress macOS "Keychain Not Found" dialog — use in-memory store.
		chromedp.Flag("password-store", "basic"),
		chromedp.Flag("use-mock-keychain", true),
	)
	defer cancelAlloc()

	ctx, cancelCtx := chromedp.NewContext(allocCtx)
	defer cancelCtx()

	ctx, cancelTimeout := context.WithTimeout(ctx, 30*time.Second)
	defer cancelTimeout()

	fileURL := "file://" + filepath.ToSlash(tmp.Name())

	var buf []byte
	if err := chromedp.Run(ctx,
		// CSS viewport is narrowed by RenderScale; EmulateScale multiplies each
		// CSS pixel by RenderScale so the physical screenshot is exactly `width`
		// pixels wide — no upscaling needed, no artifacts.
		// 1px height prevents root element stretching; FullScreenshot expands to content height.
		chromedp.EmulateViewport(int64(cssWidth), 1, chromedp.EmulateScale(RenderScale)),
		chromedp.Navigate(fileURL),
		// Full-page PNG (quality=100 selects PNG in chromedp).
		chromedp.FullScreenshot(&buf, 100),
	); err != nil {
		return nil, fmt.Errorf("render: %w", err)
	}

	return buf, nil
}

// SaveRender saves png bytes to <dataDir>/renders/render-<id>.png and returns the path.
func SaveRender(dataDir string, png []byte) (string, error) {
	dir := filepath.Join(dataDir, "renders")
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", fmt.Errorf("create renders dir: %w", err)
	}
	name := fmt.Sprintf("render-%s.png", shortid.New(time.Now()))
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
