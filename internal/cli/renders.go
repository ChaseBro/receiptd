package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/ChaseBro/receiptd/internal/client"
	"github.com/ChaseBro/receiptd/internal/imageproc"
	"github.com/ChaseBro/receiptd/internal/render"
	"github.com/spf13/cobra"
)

// renderEntry holds metadata about a saved render file.
type renderEntry struct {
	ID       string    `json:"id"`
	Path     string    `json:"path"`
	Filename string    `json:"filename"`
	Bytes    int64     `json:"bytes"`
	Modified time.Time `json:"modified"`
}

// rendersIDFromName extracts the short ID from a render filename.
// "render-a3f2c.png" → "a3f2c"
// Falls back to the first 5 chars of the stem for legacy long-timestamp names.
func rendersIDFromName(name string) string {
	stem := strings.TrimSuffix(name, filepath.Ext(name))
	after, ok := strings.CutPrefix(stem, "render-")
	if !ok {
		after = stem
	}
	if len(after) <= 5 {
		return after
	}
	// Legacy long-timestamp names — use first 5 chars as a display ID.
	return after[:5]
}

// loadRenderEntries reads all render files from dir, sorted newest-first.
func loadRenderEntries(dir string) ([]renderEntry, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read renders dir: %w", err)
	}

	var result []renderEntry
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".png") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		result = append(result, renderEntry{
			ID:       rendersIDFromName(e.Name()),
			Path:     filepath.Join(dir, e.Name()),
			Filename: e.Name(),
			Bytes:    info.Size(),
			Modified: info.ModTime(),
		})
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].Modified.After(result[j].Modified)
	})
	return result, nil
}

// formatAge returns a human-readable age string.
func formatAge(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// resolveRender finds a render entry by short ID (prefix match), bare filename, or absolute path.
func resolveRender(entries []renderEntry, query string) (*renderEntry, error) {
	// Absolute path match.
	if filepath.IsAbs(query) {
		for i := range entries {
			if entries[i].Path == query {
				return &entries[i], nil
			}
		}
		return nil, fmt.Errorf("render not found: %s", query)
	}

	// Bare filename match.
	for i := range entries {
		if entries[i].Filename == query {
			return &entries[i], nil
		}
	}

	// Short ID prefix match (case-insensitive).
	lower := strings.ToLower(query)
	var matches []int
	for i := range entries {
		if strings.HasPrefix(strings.ToLower(entries[i].ID), lower) {
			matches = append(matches, i)
		}
	}
	switch len(matches) {
	case 0:
		return nil, fmt.Errorf("no render found with ID prefix %q", query)
	case 1:
		return &entries[matches[0]], nil
	default:
		return nil, fmt.Errorf("ambiguous ID prefix %q matches %d renders; use more characters", query, len(matches))
	}
}

var rendersCmd = &cobra.Command{
	Use:   "renders",
	Short: "Manage saved render files",
}

var rendersListCmd = &cobra.Command{
	Use:   "list",
	Short: "List saved renders",
	Args:  cobra.NoArgs,
	Run: func(cmd *cobra.Command, args []string) {
		dir := filepath.Join(render.DataDir(), "renders")
		entries, err := loadRenderEntries(dir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

		if jsonOutput {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			enc.Encode(entries)
			return
		}

		if len(entries) == 0 {
			fmt.Println("No renders found.")
			return
		}

		fmt.Printf("%-7s  %-34s  %7s  %s\n", "ID", "FILENAME", "SIZE", "AGE")
		fmt.Printf("%-7s  %-34s  %7s  %s\n", "-------", strings.Repeat("-", 34), "-------", "---")
		for _, e := range entries {
			size := fmt.Sprintf("%dB", e.Bytes)
			if e.Bytes >= 1024*1024 {
				size = fmt.Sprintf("%.1fMB", float64(e.Bytes)/(1024*1024))
			} else if e.Bytes >= 1024 {
				size = fmt.Sprintf("%.1fKB", float64(e.Bytes)/1024)
			}
			fmt.Printf("%-7s  %-34s  %7s  %s\n", e.ID, e.Filename, size, formatAge(e.Modified))
		}
	},
}

var rendersPrintCmd = &cobra.Command{
	Use:   "print <id>",
	Short: "Print a saved render by short ID, filename, or path",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		dir := filepath.Join(render.DataDir(), "renders")
		entries, err := loadRenderEntries(dir)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

		entry, err := resolveRender(entries, args[0])
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

		imagePath := entry.Path

		if procActive() {
			raw, err := os.ReadFile(imagePath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error reading render: %v\n", err)
				os.Exit(1)
			}
			processed, err := imageproc.Process(raw, procOpts())
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error processing image: %v\n", err)
				os.Exit(1)
			}
			savedPath, err := render.SaveRender(render.DataDir(), processed)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error saving processed image: %v\n", err)
				os.Exit(1)
			}
			imagePath = savedPath
		}

		c := client.NewClient()
		if !c.IsServerRunning() {
			if !jsonOutput {
				fmt.Println("Starting server...")
			}
			if err := startServerAuto(); err != nil {
				fmt.Fprintf(os.Stderr, "Error: could not start server: %v\n", err)
				os.Exit(1)
			}
		}

		resp, err := c.AddJob("", "", imagePath, false)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}

		if jsonOutput {
			PrintJSON(resp)
			return
		}
		fmt.Printf("Printing render %s...\n", entry.ID)
		fmt.Printf("Job ID: %s\n", resp.Data)
	},
}

func init() {
	rootCmd.AddCommand(rendersCmd)
	rendersCmd.AddCommand(rendersListCmd)
	rendersCmd.AddCommand(rendersPrintCmd)
	addProcFlags(rendersPrintCmd)
}
