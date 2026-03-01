package fontlib

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Install downloads and installs a registered AutoInstall font.
// If yes is true, the license prompt is skipped.
func Install(slug, dataDir string, yes bool) error {
	f, ok := Lookup(slug)
	if !ok {
		return fmt.Errorf("font %q not found; run: receiptd fonts list", slug)
	}
	if !f.AutoInstall {
		return fmt.Errorf("font %q requires manual install; run: receiptd fonts info %s", slug, slug)
	}
	if IsInstalled(f, dataDir) {
		fmt.Printf("%s is already installed.\n", f.DisplayName)
		return nil
	}

	fmt.Printf("%s  —  %s\n", f.DisplayName, f.License)
	if f.Attribution != "" {
		fmt.Printf("Author: %s\n", f.Attribution)
	}
	if f.InfoURL != "" {
		fmt.Printf("Source: %s\n", f.InfoURL)
	}
	fmt.Println()

	if !yes {
		fmt.Printf("Download %s to ~/.receiptd/fonts/? [y/N] ", f.FileName)
		reader := bufio.NewReader(os.Stdin)
		line, _ := reader.ReadString('\n')
		line = strings.TrimSpace(strings.ToLower(line))
		if line != "y" && line != "yes" {
			return fmt.Errorf("aborted")
		}
	}

	if err := os.MkdirAll(FontsDir(dataDir), 0755); err != nil {
		return fmt.Errorf("create fonts dir: %w", err)
	}

	fmt.Printf("Downloading %s...", f.FileName)
	data, err := downloadURL(f.SourceURL)
	if err != nil {
		fmt.Println(" failed")
		return fmt.Errorf("download: %w", err)
	}

	if err := validateFontBytes(data, f.Format); err != nil {
		fmt.Println(" failed")
		return fmt.Errorf("validate font: %w", err)
	}

	dest := FontPath(f, dataDir)
	if err := os.WriteFile(dest, data, 0644); err != nil {
		fmt.Println(" failed")
		return fmt.Errorf("write font: %w", err)
	}

	fmt.Printf(" done (%d KB)\n", len(data)/1024)
	fmt.Printf("✓ %s installed. Use with: --font %s\n", f.DisplayName, f.Slug)
	return nil
}

// Add copies a user-provided font file into the fonts directory.
// The file is stored as-is; the slug is inferred from the filename.
func Add(srcPath, dataDir string) error {
	absPath, err := filepath.Abs(srcPath)
	if err != nil {
		return fmt.Errorf("resolve path: %w", err)
	}
	if _, err := os.Stat(absPath); err != nil {
		return fmt.Errorf("file not found: %s", absPath)
	}

	data, err := os.ReadFile(absPath)
	if err != nil {
		return fmt.Errorf("read file: %w", err)
	}

	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(absPath), "."))
	switch ext {
	case "woff2", "ttf", "otf":
		// ok
	default:
		return fmt.Errorf("unsupported font format %q; expected .woff2, .ttf, or .otf", ext)
	}

	if err := validateFontBytes(data, ext); err != nil {
		return fmt.Errorf("invalid font file: %w", err)
	}

	if err := os.MkdirAll(FontsDir(dataDir), 0755); err != nil {
		return fmt.Errorf("create fonts dir: %w", err)
	}

	dest := filepath.Join(FontsDir(dataDir), filepath.Base(absPath))
	if err := os.WriteFile(dest, data, 0644); err != nil {
		return fmt.Errorf("write font: %w", err)
	}

	fmt.Printf("✓ Copied %s to ~/.receiptd/fonts/\n", filepath.Base(absPath))
	return nil
}

// Remove deletes an installed font file from the fonts directory.
func Remove(slug, dataDir string) error {
	f, ok := Lookup(slug)
	if !ok {
		return fmt.Errorf("font %q not found; run: receiptd fonts list", slug)
	}
	dest := FontPath(f, dataDir)
	if err := os.Remove(dest); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("font %q is not installed", slug)
		}
		return fmt.Errorf("remove font: %w", err)
	}
	fmt.Printf("✓ %s removed.\n", f.DisplayName)
	return nil
}

// downloadURL fetches a URL and returns the body bytes.
func downloadURL(url string) ([]byte, error) {
	resp, err := http.Get(url) //nolint:gosec // URL comes from the hardcoded registry
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}
	return io.ReadAll(resp.Body)
}

// validateFontBytes checks the magic bytes of a font file.
func validateFontBytes(data []byte, format string) error {
	if len(data) < 4 {
		return fmt.Errorf("file too small to be a valid font")
	}
	switch strings.ToLower(format) {
	case "woff2":
		// WOFF2 magic: 0x774F4632
		if data[0] != 0x77 || data[1] != 0x4F || data[2] != 0x46 || data[3] != 0x32 {
			return fmt.Errorf("not a valid WOFF2 file")
		}
	case "ttf", "otf":
		// TTF/OTF magic: 0x00010000 (TrueType) or 0x4F54544F (OTF CFF)
		ttf := data[0] == 0x00 && data[1] == 0x01 && data[2] == 0x00 && data[3] == 0x00
		otf := data[0] == 0x4F && data[1] == 0x54 && data[2] == 0x54 && data[3] == 0x4F
		if !ttf && !otf {
			return fmt.Errorf("not a valid TTF/OTF file")
		}
	}
	return nil
}
