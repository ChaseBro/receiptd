package printlib

import (
	"encoding/base64"
	"fmt"
	"os"
	"strings"

	"github.com/ChaseBro/receiptd/internal/fontlib"
	"github.com/ChaseBro/receiptd/internal/render"
)

func init() {
	allItems = append(allItems,
		Item{
			Name:        "font-specimen",
			Description: "Render every installed font in its own typeface — font discovery sheet",
			Kind:        KindTest,
			Mode:        ModeRender,
			Tags:        []string{"fonts", "test", "bitmap"},
			HTMLFn:      htmlFontSpecimen,
		},
	)
}

func htmlFontSpecimen() string {
	dataDir := render.DataDir()
	fonts := fontlib.All()

	var faceBlocks strings.Builder
	var rows strings.Builder

	installedCount := 0
	for _, f := range fonts {
		installed := fontlib.IsInstalled(f, dataDir)
		if installed {
			installedCount++
		}

		// @font-face block — only for installed fonts; embed as base64 data URI
		// to avoid file:// cross-origin restrictions in headless Chrome.
		if installed {
			fontData, err := os.ReadFile(fontlib.FontPath(f, dataDir))
			if err == nil {
				encoded := base64.StdEncoding.EncodeToString(fontData)
				faceBlocks.WriteString(fmt.Sprintf(`
@font-face {
  font-family: '%s';
  src: url('data:%s;base64,%s') format('%s');
}`, f.Family, fontlib.FontMIME(f.Format), encoded, fontlib.CSSFormatHint(f.Format)))
			}
		}

		// Row for this font
		if installed {
			rows.WriteString(fmt.Sprintf(`
<div class="font-row installed">
  <div class="meta">
    <span class="slug">%s</span>
    <span class="badge">installed</span>
  </div>
  <div class="sample" style="font-family:'%s',monospace;font-size:%dpx;-webkit-font-smoothing:none;font-smooth:never;text-rendering:optimizeSpeed;">%s</div>
  <div class="sample2" style="font-family:'%s',monospace;font-size:%dpx;-webkit-font-smoothing:none;font-smooth:never;text-rendering:optimizeSpeed;">0123456789 !@#$%%&amp;</div>
</div>`,
				htmlEscapeStr(f.Slug),
				f.Family, f.DefaultSize,
				htmlEscapeStr(f.DisplayName),
				f.Family, f.DefaultSize,
			))
		} else {
			rows.WriteString(fmt.Sprintf(`
<div class="font-row">
  <div class="meta">
    <span class="slug">%s</span>
    <span class="badge missing-badge">not installed</span>
  </div>
  <div class="sample placeholder">%s</div>
</div>`,
				htmlEscapeStr(f.Slug),
				htmlEscapeStr(f.DisplayName),
			))
		}
	}

	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
%s
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 576px;
  font-family: monospace;
  background: white;
  color: black;
  padding: 12px;
}
.header {
  text-align: center;
  margin-bottom: 10px;
  border-bottom: 2px solid black;
  padding-bottom: 8px;
}
.header h1 { font-size: 22px; font-weight: bold; letter-spacing: 2px; }
.header .sub { font-size: 16px; margin-top: 3px; }
.font-row {
  border-bottom: 1px solid black;
  padding: 7px 0;
}
.meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 3px;
}
.slug { font-family: monospace; font-size: 14px; }
.badge {
  font-family: monospace;
  font-size: 12px;
  background: black;
  color: white;
  padding: 1px 4px;
}
.missing-badge {
  background: white;
  color: black;
  border: 1px solid black;
}
.sample {
  color: black;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
}
.sample2 {
  color: black;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
}
.placeholder {
  font-family: monospace;
  font-size: 16px;
}
.footer {
  margin-top: 10px;
  font-size: 16px;
  text-align: center;
}
</style>
</head>
<body>
<div class="header">
  <h1>FONT SPECIMEN</h1>
  <div class="sub">%d of %d fonts installed · receiptd fonts list</div>
</div>
%s
<div class="footer">receiptd fonts install &lt;name&gt; to add more</div>
</body>
</html>`,
		faceBlocks.String(),
		installedCount, len(fonts),
		rows.String(),
	)
}

func htmlEscapeStr(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, `"`, "&#34;")
	return s
}
