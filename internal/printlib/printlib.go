package printlib

import (
	"embed"
	"fmt"
	"os"
	"strings"
)

// Kind describes what an item is — its conceptual role in the library.
type Kind string

const (
	KindTest     Kind = "test"     // Printer capability discovery
	KindTemplate Kind = "template" // Reusable production-ready layout
	KindExample  Kind = "example"  // Technique demonstration
	KindPattern  Kind = "pattern"  // Reusable design component
)

// PrintMode describes how the item is dispatched to the printer.
type PrintMode string

const (
	ModeMarkup PrintMode = "markup" // Star Markup text path
	ModeRender PrintMode = "render" // HTML → Chrome → PNG path
	ModeImage  PrintMode = "image"  // Raw PNG file path
)

// Item is a single named entry in the print library.
type Item struct {
	Name        string
	Description string
	Kind        Kind
	Mode        PrintMode
	Tags        []string

	MarkupFn func() string                    // ModeMarkup: returns Star Markup (no [cut])
	HTMLFn   func() string                    // ModeRender: returns full HTML document
	ImageFn  func() (path, caption string)    // ModeImage: returns temp path + caption
}

//go:embed testdata/images/*
var imageFS embed.FS

// ImageAsset extracts a file from the embedded FS to a temp file and returns the path.
// The caller is responsible for removing the temp file when done.
func ImageAsset(filename string) (string, error) {
	data, err := imageFS.ReadFile("testdata/images/" + filename)
	if err != nil {
		return "", fmt.Errorf("embedded asset %q: %w", filename, err)
	}
	tmp, err := os.CreateTemp("", "receiptd-asset-*.png")
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", fmt.Errorf("write temp file: %w", err)
	}
	tmp.Close()
	return tmp.Name(), nil
}

// allItems is the ordered registry; each *_items.go init() appends to it.
var allItems []Item

// All returns the full ordered registry of items.
func All() []Item {
	out := make([]Item, len(allItems))
	copy(out, allItems)
	return out
}

// Lookup finds an item by name (case-insensitive exact match).
func Lookup(name string) (Item, bool) {
	lower := strings.ToLower(name)
	for _, item := range allItems {
		if strings.ToLower(item.Name) == lower {
			return item, true
		}
	}
	return Item{}, false
}
