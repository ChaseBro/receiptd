package fontlib_test

import (
	"testing"

	"github.com/ChaseBro/receiptd/internal/fontlib"
)

func TestAll_NonEmpty(t *testing.T) {
	fonts := fontlib.All()
	if len(fonts) == 0 {
		t.Fatal("All() returned empty registry; expected registered fonts")
	}
}

func TestLookup_Found(t *testing.T) {
	f, ok := fontlib.Lookup("press-start-2p")
	if !ok {
		t.Fatal("Lookup(\"press-start-2p\") returned false; expected to find the font")
	}
	if f.Slug != "press-start-2p" {
		t.Errorf("Slug = %q; want \"press-start-2p\"", f.Slug)
	}
	if f.Family == "" {
		t.Error("Family is empty")
	}
	if f.FileName == "" {
		t.Error("FileName is empty")
	}
}

func TestLookup_CaseInsensitive(t *testing.T) {
	_, ok := fontlib.Lookup("PRESS-START-2P")
	if !ok {
		t.Error("Lookup is not case-insensitive")
	}
}

func TestLookup_NotFound(t *testing.T) {
	_, ok := fontlib.Lookup("no-such-font")
	if ok {
		t.Error("Lookup(\"no-such-font\") returned true; expected false")
	}
}

func TestIsInstalled_NotInstalled(t *testing.T) {
	f, ok := fontlib.Lookup("press-start-2p")
	if !ok {
		t.Fatal("press-start-2p not in registry")
	}
	// Use a temp dir that doesn't have any fonts in it.
	tmpDir := t.TempDir()
	if fontlib.IsInstalled(f, tmpDir) {
		t.Error("IsInstalled returned true for empty temp dir")
	}
}

func TestInstalled_EmptyDir(t *testing.T) {
	tmpDir := t.TempDir()
	installed := fontlib.Installed(tmpDir)
	if len(installed) != 0 {
		t.Errorf("Installed() = %d fonts; want 0 for empty dir", len(installed))
	}
}

func TestAllFonts_HaveRequiredFields(t *testing.T) {
	for _, f := range fontlib.All() {
		if f.Slug == "" {
			t.Errorf("font with DisplayName=%q has empty Slug", f.DisplayName)
		}
		if f.DisplayName == "" {
			t.Errorf("font %q has empty DisplayName", f.Slug)
		}
		if f.Family == "" {
			t.Errorf("font %q has empty Family", f.Slug)
		}
		if f.FileName == "" {
			t.Errorf("font %q has empty FileName", f.Slug)
		}
		if f.Format == "" {
			t.Errorf("font %q has empty Format", f.Slug)
		}
		if f.DefaultSize <= 0 {
			t.Errorf("font %q has DefaultSize <= 0", f.Slug)
		}
		if f.AutoInstall && f.SourceURL == "" {
			t.Errorf("font %q has AutoInstall=true but empty SourceURL", f.Slug)
		}
		if !f.AutoInstall && f.InfoURL == "" {
			t.Errorf("font %q has AutoInstall=false but empty InfoURL", f.Slug)
		}
	}
}
