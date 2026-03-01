package cli

import (
	"fmt"
	"os"
	"strings"

	"github.com/ChaseBro/receiptd/internal/fontlib"
	"github.com/ChaseBro/receiptd/internal/render"
	"github.com/spf13/cobra"
)

var fontsCmd = &cobra.Command{
	Use:   "fonts",
	Short: "Manage bitmap fonts for thermal receipt rendering",
	Long: `Browse, install, and manage bitmap fonts for use with --font.

Bitmap fonts render crisply at their design pixel sizes, eliminating the
gray anti-aliasing fringe that appears with system fonts on thermal paper.

Examples:
  receiptd fonts list                       # show all available fonts
  receiptd fonts list --installed           # show installed fonts only
  receiptd fonts info press-start-2p        # show details and install instructions
  receiptd fonts install press-start-2p     # auto-install (where supported)
  receiptd fonts add ~/Downloads/myfont.ttf # copy a font you downloaded manually
  receiptd fonts remove vcr-osd-mono        # uninstall a font`,
}

// ── list ────────────────────────────────────────────────────────────────────

var (
	fontsListInstalled bool
	fontsListAvailable bool
	fontsListTag       string
)

var fontsListCmd = &cobra.Command{
	Use:   "list",
	Short: "List available and installed fonts",
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		dataDir := render.DataDir()
		fonts := fontlib.All()

		// Filter
		var filtered []fontlib.Font
		for _, f := range fonts {
			installed := fontlib.IsInstalled(f, dataDir)
			if fontsListInstalled && !installed {
				continue
			}
			if fontsListTag != "" && !hasTag(f.Tags, fontsListTag) {
				continue
			}
			filtered = append(filtered, f)
		}

		if len(filtered) == 0 {
			fmt.Println("No fonts match.")
			return
		}

		fmt.Printf("%-22s  %-22s  %-10s  %-12s  %s\n", "NAME", "DISPLAY NAME", "SIZES", "LICENSE", "INSTALLED")
		fmt.Println(strings.Repeat("─", 82))
		for _, f := range filtered {
			installed := "  -"
			if fontlib.IsInstalled(f, dataDir) {
				installed = "  ✓"
			}
			sizes := formatSizes(f.DesignSizes)
			fmt.Printf("%-22s  %-22s  %-10s  %-12s  %s\n",
				f.Slug, f.DisplayName, sizes, f.License, installed)
		}
		fmt.Printf("\n%d font(s)\n", len(filtered))
	},
}

// ── info ────────────────────────────────────────────────────────────────────

var fontsInfoCmd = &cobra.Command{
	Use:   "info <name>",
	Short: "Show details and install instructions for a font",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		f, ok := fontlib.Lookup(args[0])
		if !ok {
			fmt.Fprintf(os.Stderr, "Error: font %q not found. Run 'receiptd fonts list' to see all fonts.\n", args[0])
			os.Exit(1)
		}
		dataDir := render.DataDir()

		fmt.Printf("%s\n", f.DisplayName)
		fmt.Printf("License:     %s\n", f.License)
		if f.Attribution != "" {
			fmt.Printf("Author:      %s\n", f.Attribution)
		}
		if f.Description != "" {
			fmt.Printf("Description: %s\n", f.Description)
		}
		if len(f.Tags) > 0 {
			fmt.Printf("Tags:        %s\n", strings.Join(f.Tags, ", "))
		}
		if len(f.DesignSizes) > 0 {
			fmt.Printf("Sizes:       %s\n", formatSizes(f.DesignSizes))
		}
		fmt.Println()

		if fontlib.IsInstalled(f, dataDir) {
			fmt.Printf("Status:  installed (%s)\n", fontlib.FontPath(f, dataDir))
		} else if f.AutoInstall {
			fmt.Printf("To install, run:\n  receiptd fonts install %s\n", f.Slug)
		} else {
			fmt.Printf("To install, download from:\n  %s\n\n", f.InfoURL)
			fmt.Printf("Save the font file as:  ~/.receiptd/fonts/%s\n", f.FileName)
			fmt.Printf("Or run:  receiptd fonts add /path/to/%s\n", f.FileName)
		}
	},
}

// ── install ──────────────────────────────────────────────────────────────────

var fontsInstallYes bool

var fontsInstallCmd = &cobra.Command{
	Use:   "install <name>",
	Short: "Download and install an auto-install font",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		dataDir := render.DataDir()
		if err := fontlib.Install(args[0], dataDir, fontsInstallYes); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	},
}

// ── add ──────────────────────────────────────────────────────────────────────

var fontsAddCmd = &cobra.Command{
	Use:   "add <path>",
	Short: "Copy a user-provided font file into ~/.receiptd/fonts/",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		dataDir := render.DataDir()
		if err := fontlib.Add(args[0], dataDir); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	},
}

// ── remove ──────────────────────────────────────────────────────────────────

var fontsRemoveCmd = &cobra.Command{
	Use:     "remove <name>",
	Aliases: []string{"rm"},
	Short:   "Delete an installed font from ~/.receiptd/fonts/",
	Args:    cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		dataDir := render.DataDir()
		if err := fontlib.Remove(args[0], dataDir); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	},
}

// ── helpers ──────────────────────────────────────────────────────────────────

func hasTag(tags []string, tag string) bool {
	lower := strings.ToLower(tag)
	for _, t := range tags {
		if strings.ToLower(t) == lower {
			return true
		}
	}
	return false
}

func formatSizes(sizes []int) string {
	if len(sizes) == 0 {
		return "-"
	}
	parts := make([]string, len(sizes))
	for i, s := range sizes {
		parts[i] = fmt.Sprintf("%dpx", s)
	}
	return strings.Join(parts, "/")
}

func init() {
	rootCmd.AddCommand(fontsCmd)
	fontsCmd.AddCommand(fontsListCmd)
	fontsCmd.AddCommand(fontsInfoCmd)
	fontsCmd.AddCommand(fontsInstallCmd)
	fontsCmd.AddCommand(fontsAddCmd)
	fontsCmd.AddCommand(fontsRemoveCmd)

	fontsListCmd.Flags().BoolVar(&fontsListInstalled, "installed", false, "Show only installed fonts")
	fontsListCmd.Flags().BoolVar(&fontsListAvailable, "available", false, "Show only not-yet-installed fonts")
	fontsListCmd.Flags().StringVar(&fontsListTag, "tag", "", "Filter by tag: receipt|fun|bitmap|retro|monospace")

	fontsInstallCmd.Flags().BoolVarP(&fontsInstallYes, "yes", "y", false, "Skip the license confirmation prompt")
}
