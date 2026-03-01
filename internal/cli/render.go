package cli

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/ChaseBro/receiptd/internal/render"
	"github.com/spf13/cobra"
)

var (
	renderOutput string
	renderWidth  int
)

var renderCmd = &cobra.Command{
	Use:   "render [html]",
	Short: "Render HTML to a PNG for preview before printing",
	Long: `Render HTML to a PNG image using headless Chrome.

Use this command to preview and iterate on your HTML layout before printing.
The rendered PNG matches the printer's paper width (576px by default).

Read HTML from arguments, a file, or stdin:
  receiptd render '<h1>Hello</h1>'
  receiptd render - < template.html
  echo '<h1>Hello</h1>' | receiptd render -

Save to a specific file:
  receiptd render --output preview.png '<h1>Hello</h1>'

Requires Chrome or Chromium to be installed.`,
	Args: cobra.ArbitraryArgs,
	Run: func(cmd *cobra.Command, args []string) {
		html := readHTMLInput(args)

		width := renderWidth
		if width <= 0 {
			width = render.PrinterWidth
		}

		if !jsonOutput {
			fmt.Fprintf(os.Stderr, "Rendering at %dpx...\n", width)
		}

		png, err := render.HTMLToPNG(html, width)
		if err != nil {
			if jsonOutput {
				fmt.Printf(`{"error":"render failed: %s"}`, err)
			} else {
				fmt.Fprintf(os.Stderr, "Error: render failed: %v\n", err)
				fmt.Fprintf(os.Stderr, "Make sure Chrome or Chromium is installed.\n")
			}
			os.Exit(1)
		}

		// Determine output path
		outPath := renderOutput
		if outPath == "" {
			saved, err := render.SaveRender(render.DataDir(), png)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error saving render: %v\n", err)
				os.Exit(1)
			}
			outPath = saved
		} else {
			if err := os.WriteFile(outPath, png, 0644); err != nil {
				fmt.Fprintf(os.Stderr, "Error writing output: %v\n", err)
				os.Exit(1)
			}
		}

		if jsonOutput {
			fmt.Printf(`{"path":%q,"width":%d,"bytes":%d}`, outPath, width, len(png))
		} else {
			fmt.Printf("Rendered PNG: %s (%d bytes)\n", outPath, len(png))
			fmt.Printf("Open with: open %q\n", outPath)
		}
	},
}

// readHTMLInput reads HTML from args or stdin.
// If args contain "-" or args is empty, reads stdin.
func readHTMLInput(args []string) string {
	readStdin := len(args) == 0 || (len(args) == 1 && args[0] == "-")
	if !readStdin {
		if stat, err := os.Stdin.Stat(); err == nil {
			readStdin = (stat.Mode() & os.ModeCharDevice) == 0
		}
	}
	if readStdin {
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading stdin: %v\n", err)
			os.Exit(1)
		}
		return strings.TrimRight(string(data), "\n")
	}
	return strings.Join(args, " ")
}

func init() {
	rootCmd.AddCommand(renderCmd)
	renderCmd.Flags().StringVarP(&renderOutput, "output", "o", "", "Output PNG path (default: ~/.receiptd/renders/<timestamp>.png)")
	renderCmd.Flags().IntVar(&renderWidth, "width", 0, fmt.Sprintf("Viewport width in CSS pixels (default: %d)", render.PrinterWidth))
}
