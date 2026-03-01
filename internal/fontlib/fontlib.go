package fontlib

import (
	"os"
	"path/filepath"
	"strings"
)

// Font describes a bitmap or pixel font available for thermal receipt rendering.
type Font struct {
	Slug        string   // CLI identifier: "spleen-8x16"
	DisplayName string   // "Spleen 8×16"
	Family      string   // CSS font-family: "Spleen"
	FileName    string   // stored as: ~/.receiptd/fonts/spleen-8x16.woff2
	Format      string   // "woff2", "ttf", "otf"
	DesignSizes []int    // pixel sizes the font is designed for: [16]
	DefaultSize int      // recommended font-size for thermal printing in CSS px (2× the design pixel grid)
	License     string   // "BSD-2", "OFL", "Free (personal)", "GPL-2"
	Attribution string   // author credit
	SourceURL   string   // direct file download URL (AutoInstall=true) or homepage (AutoInstall=false)
	InfoURL     string   // homepage/dafont page shown in `fonts info` output
	Tags        []string // ["bitmap","monospace","receipt","retro","fun"]
	Description string
	AutoInstall bool // true = direct file download; false = manual install required
}

// allFonts is the ordered registry; each *_fonts.go init() appends to it.
var allFonts []Font

// register appends fonts to the global registry (called from init() in each *_fonts.go).
func register(fonts ...Font) {
	allFonts = append(allFonts, fonts...)
}

// All returns a copy of the full ordered font registry.
func All() []Font {
	out := make([]Font, len(allFonts))
	copy(out, allFonts)
	return out
}

// Lookup finds a font by slug (case-insensitive).
func Lookup(slug string) (Font, bool) {
	lower := strings.ToLower(slug)
	for _, f := range allFonts {
		if strings.ToLower(f.Slug) == lower {
			return f, true
		}
	}
	return Font{}, false
}

// FontsDir returns the fonts directory path within dataDir.
func FontsDir(dataDir string) string {
	return filepath.Join(dataDir, "fonts")
}

// FontPath returns the absolute path where a font file would be stored.
func FontPath(f Font, dataDir string) string {
	return filepath.Join(FontsDir(dataDir), f.FileName)
}

// IsInstalled reports whether the font file exists on disk.
func IsInstalled(f Font, dataDir string) bool {
	_, err := os.Stat(FontPath(f, dataDir))
	return err == nil
}

// Installed returns all registered fonts that are installed in dataDir.
func Installed(dataDir string) []Font {
	var out []Font
	for _, f := range allFonts {
		if IsInstalled(f, dataDir) {
			out = append(out, f)
		}
	}
	return out
}
