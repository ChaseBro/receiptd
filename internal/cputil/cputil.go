// Package cputil wraps the Star CloudPRNT SDK's `cputil` binary. It resolves
// the binary path, builds Star Markup with an optional image prefix, and
// converts markup into the StarPRNT binary format that printers consume.
//
// Both the local CloudPRNT handler (lazy conversion on printer GET) and the
// cloud-mode dispatcher (eager conversion at job-create time) go through here.
package cputil

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// MediaTypeStarPRNT is the content type of the binary cputil emits.
const MediaTypeStarPRNT = "application/vnd.star.starprnt"

// ResolvePath returns the cputil binary to use. Preference order:
//  1. $CPUTIL_PATH (explicit override, used in Docker).
//  2. `cputil` on $PATH.
//
// Returns an empty string if neither resolves; callers should treat that as a
// hard failure at startup.
func ResolvePath() string {
	if p := os.Getenv("CPUTIL_PATH"); p != "" {
		return p
	}
	if p, err := exec.LookPath("cputil"); err == nil {
		return p
	}
	return ""
}

// BuildMarkup constructs a Star Markup document from a content body and an
// optional image path. When imagePath is set, an `[image: url ...]` tag is
// prepended so cputil rasterizes the image inline. Absolute local paths are
// wrapped in `file://`; existing URL schemes pass through untouched.
func BuildMarkup(content, imagePath string) string {
	if imagePath == "" {
		return content
	}
	url := imagePath
	if !strings.HasPrefix(url, "file://") &&
		!strings.HasPrefix(url, "http://") &&
		!strings.HasPrefix(url, "https://") &&
		!strings.HasPrefix(url, "data:") {
		url = "file://" + url
	}
	return fmt.Sprintf("[image: url %s; width 100%%]\n%s", url, content)
}

// Convert runs cputil to translate Star Markup (`.stm`) into the StarPRNT
// binary format. cputilPath must be an absolute path to the binary; the
// binary loads support files from its own directory so callers must not
// relocate it.
func Convert(cputilPath, markup string) ([]byte, error) {
	if cputilPath == "" {
		return nil, fmt.Errorf("cputil path not set")
	}
	tmpFile, err := os.CreateTemp("", "markup-*.stm")
	if err != nil {
		return nil, fmt.Errorf("create temp markup: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	if _, err := tmpFile.WriteString(markup); err != nil {
		tmpFile.Close()
		return nil, fmt.Errorf("write markup: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return nil, fmt.Errorf("close markup: %w", err)
	}

	cmd := exec.Command(cputilPath, "thermal3", "decode", MediaTypeStarPRNT, tmpFile.Name(), "-")
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("cputil: %w", err)
	}
	return out, nil
}
