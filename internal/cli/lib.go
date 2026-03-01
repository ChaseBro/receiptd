package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ChaseBro/receiptd/internal/client"
	"github.com/ChaseBro/receiptd/internal/imageproc"
	"github.com/ChaseBro/receiptd/internal/printlib"
	"github.com/ChaseBro/receiptd/internal/render"
	"github.com/spf13/cobra"
)

var libCmd = &cobra.Command{
	Use:   "lib",
	Short: "Browse, preview, and run items from the print library",
	Long: `The print library contains tests, templates, examples, and patterns
for the thermal receipt printer.

Use 'lib list' to browse, 'lib show <name>' to inspect, 'lib preview <name>'
to render locally, and 'lib run <name>' to send to the printer.`,
}

// ── list ────────────────────────────────────────────────────────────────────

var libListKind string

var libListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all items in the print library",
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		items := printlib.All()
		if libListKind != "" {
			filtered := items[:0]
			for _, it := range items {
				if strings.EqualFold(string(it.Kind), libListKind) {
					filtered = append(filtered, it)
				}
			}
			items = filtered
		}

		if jsonOutput {
			type row struct {
				Name        string `json:"name"`
				Kind        string `json:"kind"`
				Mode        string `json:"mode"`
				Description string `json:"description"`
				Tags        []string `json:"tags,omitempty"`
			}
			rows := make([]row, len(items))
			for i, it := range items {
				rows[i] = row{it.Name, string(it.Kind), string(it.Mode), it.Description, it.Tags}
			}
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			enc.Encode(rows)
			return
		}

		// Human-readable table
		fmt.Printf("%-20s  %-8s  %-6s  %s\n", "NAME", "KIND", "MODE", "DESCRIPTION")
		fmt.Println(strings.Repeat("─", 72))
		for _, it := range items {
			fmt.Printf("%-20s  %-8s  %-6s  %s\n", it.Name, string(it.Kind), string(it.Mode), it.Description)
		}
		fmt.Printf("\n%d item(s)", len(items))
		if libListKind != "" {
			fmt.Printf(" (kind: %s)", libListKind)
		}
		fmt.Println()
	},
}

// ── show ────────────────────────────────────────────────────────────────────

var libShowCmd = &cobra.Command{
	Use:   "show <name>",
	Short: "Show details for a library item",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		it, ok := printlib.Lookup(args[0])
		if !ok {
			fmt.Fprintf(os.Stderr, "Error: item %q not found. Run 'receiptd lib list' to see all items.\n", args[0])
			os.Exit(1)
		}

		if jsonOutput {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			enc.Encode(map[string]interface{}{
				"name":        it.Name,
				"kind":        string(it.Kind),
				"mode":        string(it.Mode),
				"description": it.Description,
				"tags":        it.Tags,
			})
			return
		}

		fmt.Printf("Name:        %s\n", it.Name)
		fmt.Printf("Kind:        %s\n", it.Kind)
		fmt.Printf("Mode:        %s\n", it.Mode)
		fmt.Printf("Description: %s\n", it.Description)
		if len(it.Tags) > 0 {
			fmt.Printf("Tags:        %s\n", strings.Join(it.Tags, ", "))
		}
	},
}

// ── run ─────────────────────────────────────────────────────────────────────

var libRunCmd = &cobra.Command{
	Use:   "run <name>",
	Short: "Run a library item on the printer",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		it, ok := printlib.Lookup(args[0])
		if !ok {
			fmt.Fprintf(os.Stderr, "Error: item %q not found. Run 'receiptd lib list' to see all items.\n", args[0])
			os.Exit(1)
		}
		if err := ensureServer(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if err := runItem(it); err != nil {
			fmt.Fprintf(os.Stderr, "Error running %q: %v\n", it.Name, err)
			os.Exit(1)
		}
		fmt.Printf("✓ %s sent to printer\n", it.Name)
	},
}

func ensureServer() error {
	c := client.NewClient()
	if c.IsServerRunning() {
		return nil
	}
	if !jsonOutput {
		fmt.Println("Starting server...")
	}
	return startServerAuto()
}

func runItem(it printlib.Item) error {
	c := client.NewClient()
	switch it.Mode {
	case printlib.ModeMarkup:
		markup := it.MarkupFn()
		_, err := c.AddJob("", markup, "", false)
		return err

	case printlib.ModeRender:
		html := it.HTMLFn()
		if !jsonOutput {
			fmt.Fprintf(os.Stderr, "  Rendering %s...\n", it.Name)
		}
		png, err := render.HTMLToPNG(html, render.PrinterWidth)
		if err != nil {
			return fmt.Errorf("render: %w", err)
		}
		png, err = imageproc.Process(png, procOpts())
		if err != nil {
			return fmt.Errorf("process: %w", err)
		}
		saved, err := render.SaveRender(render.DataDir(), png)
		if err != nil {
			return fmt.Errorf("save render: %w", err)
		}
		_, err = c.AddJob("", "", saved, false)
		return err

	case printlib.ModeImage:
		path, caption := it.ImageFn()
		if path == "" {
			return fmt.Errorf("image asset unavailable")
		}
		defer os.Remove(path)

		var finalPath string
		if procActive() {
			raw, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("read image: %w", err)
			}
			processed, err := imageproc.Process(raw, procOpts())
			if err != nil {
				return fmt.Errorf("process image: %w", err)
			}
			saved, err := render.SaveRender(render.DataDir(), processed)
			if err != nil {
				return fmt.Errorf("save processed image: %w", err)
			}
			finalPath = saved
		} else {
			// Apply default floyd-steinberg for photo-test
			raw, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("read image: %w", err)
			}
			processed, err := imageproc.Process(raw, imageproc.Options{Algorithm: imageproc.FloydSteinberg})
			if err != nil {
				return fmt.Errorf("process image: %w", err)
			}
			saved, err := render.SaveRender(render.DataDir(), processed)
			if err != nil {
				return fmt.Errorf("save processed image: %w", err)
			}
			finalPath = saved
		}

		_, err := c.AddJob("", caption, finalPath, false)
		return err

	default:
		return fmt.Errorf("unknown mode %q", it.Mode)
	}
}

// ── preview ──────────────────────────────────────────────────────────────────

var libPreviewOutput string

var libPreviewCmd = &cobra.Command{
	Use:   "preview <name>",
	Short: "Render a library item to PNG locally (no printer needed)",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		it, ok := printlib.Lookup(args[0])
		if !ok {
			fmt.Fprintf(os.Stderr, "Error: item %q not found. Run 'receiptd lib list' to see all items.\n", args[0])
			os.Exit(1)
		}

		png, err := previewItem(it)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error previewing %q: %v\n", it.Name, err)
			os.Exit(1)
		}

		outPath := libPreviewOutput
		if outPath == "" {
			ts := time.Now().UnixNano()
			name := fmt.Sprintf("preview-%s-%d.png", it.Name, ts)
			dir := filepath.Join(render.DataDir(), "renders")
			if err := os.MkdirAll(dir, 0755); err != nil {
				fmt.Fprintf(os.Stderr, "Error creating renders dir: %v\n", err)
				os.Exit(1)
			}
			outPath = filepath.Join(dir, name)
		}

		if err := os.WriteFile(outPath, png, 0644); err != nil {
			fmt.Fprintf(os.Stderr, "Error writing output: %v\n", err)
			os.Exit(1)
		}

		if jsonOutput {
			fmt.Printf(`{"path":%q,"bytes":%d}`, outPath, len(png))
			return
		}
		fmt.Printf("Preview: %s (%d bytes)\n", outPath, len(png))
		fmt.Printf("Open:    open %q\n", outPath)
	},
}

func previewItem(it printlib.Item) ([]byte, error) {
	switch it.Mode {
	case printlib.ModeMarkup:
		markup := it.MarkupFn()
		html := markupToPreviewHTML(markup)
		if !jsonOutput {
			fmt.Fprintf(os.Stderr, "Rendering markup preview...\n")
		}
		png, err := render.HTMLToPNG(html, render.PrinterWidth)
		if err != nil {
			return nil, fmt.Errorf("render: %w", err)
		}
		return imageproc.Process(png, procOpts())

	case printlib.ModeRender:
		html := it.HTMLFn()
		if !jsonOutput {
			fmt.Fprintf(os.Stderr, "Rendering HTML preview...\n")
		}
		png, err := render.HTMLToPNG(html, render.PrinterWidth)
		if err != nil {
			return nil, fmt.Errorf("render: %w", err)
		}
		return imageproc.Process(png, procOpts())

	case printlib.ModeImage:
		path, _ := it.ImageFn()
		if path == "" {
			return nil, fmt.Errorf("image asset unavailable")
		}
		defer os.Remove(path)
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read image: %w", err)
		}
		if procActive() {
			return imageproc.Process(raw, procOpts())
		}
		return raw, nil

	default:
		return nil, fmt.Errorf("unknown mode %q", it.Mode)
	}
}

// markupToPreviewHTML wraps Star Markup in an HTML <pre> block for Chrome rendering.
// This is a best-effort preview; the actual printer renders natively.
func markupToPreviewHTML(markup string) string {
	// Strip Star Markup tags for a clean text preview.
	clean := stripMarkupTags(markup)
	escaped := htmlEscape(clean)
	return fmt.Sprintf(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  width: 576px;
  font-family: 'Courier New', Courier, monospace;
  font-size: 20px;
  padding: 12px;
  background: white;
  color: black;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
</head>
<body>%s</body>
</html>`, escaped)
}

// stripMarkupTags removes [tag: ...] Star Markup tags, leaving plain text.
func stripMarkupTags(s string) string {
	var sb strings.Builder
	i := 0
	for i < len(s) {
		if s[i] == '[' {
			end := strings.IndexByte(s[i:], ']')
			if end >= 0 {
				i += end + 1
				continue
			}
		}
		sb.WriteByte(s[i])
		i++
	}
	return sb.String()
}

func htmlEscape(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	return s
}

func init() {
	rootCmd.AddCommand(libCmd)
	libCmd.AddCommand(libListCmd)
	libCmd.AddCommand(libShowCmd)
	libCmd.AddCommand(libRunCmd)
	libCmd.AddCommand(libPreviewCmd)

	libListCmd.Flags().StringVar(&libListKind, "kind", "", "Filter by kind: test|template|example|pattern")

	libPreviewCmd.Flags().StringVarP(&libPreviewOutput, "output", "o", "", "Output PNG path")
	addProcFlags(libRunCmd)
	addProcFlags(libPreviewCmd)
}
