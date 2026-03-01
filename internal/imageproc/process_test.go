package imageproc

import (
	"bytes"
	"image"
	"image/png"
	"math"
	"testing"
)

// ── helpers ───────────────────────────────────────────────────────────────────

// makeGradient creates a w×h NRGBA image with a horizontal gray gradient
// (leftmost column = 0, rightmost = 255). Alpha is always 255.
func makeGradient(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			v := uint8(math.Round(float64(x) / float64(w-1) * 255))
			i := img.PixOffset(x, y)
			img.Pix[i+0] = v
			img.Pix[i+1] = v
			img.Pix[i+2] = v
			img.Pix[i+3] = 255
		}
	}
	return img
}

// pngEncode encodes any image.Image to PNG bytes.
func pngEncode(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("pngEncode: %v", err)
	}
	return buf.Bytes()
}

// pngDecode decodes PNG bytes back to image.Image.
func pngDecode(t *testing.T, data []byte) image.Image {
	t.Helper()
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("pngDecode: %v", err)
	}
	return img
}

// isBinary returns true if every pixel in img has RGB values that are each
// either 0 or 255. Uses RGBA() which returns values in [0, 65535].
func isBinary(img image.Image) bool {
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bv, _ := img.At(x, y).RGBA()
			for _, ch := range []uint32{r, g, bv} {
				if ch != 0 && ch != 65535 {
					return false
				}
			}
		}
	}
	return true
}

// pixel1 returns a 1×1 NRGBA image with the given channel values.
func pixel1(r, g, b, a uint8) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	img.Pix[0] = r
	img.Pix[1] = g
	img.Pix[2] = b
	img.Pix[3] = a
	return img
}

// ── Process (end-to-end) ──────────────────────────────────────────────────────

func TestProcessNoOp(t *testing.T) {
	src := pngEncode(t, makeGradient(16, 16))

	// Zero-value Options must return the original bytes unchanged.
	got, err := Process(src, Options{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got, src) {
		t.Error("zero-value Options: returned different bytes")
	}

	// Explicit None with default Gamma is also a no-op.
	got2, err := Process(src, Options{Algorithm: None, Gamma: 1.0})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(got2, src) {
		t.Error("Algorithm:None + Gamma:1.0: returned different bytes")
	}
}

func TestProcessAlgorithms(t *testing.T) {
	src := pngEncode(t, makeGradient(64, 64))

	algs := []Algorithm{Threshold, FloydSteinberg, Atkinson, Bayer, Hilbert, BlueNoise}
	for _, alg := range algs {
		alg := alg
		t.Run(string(alg), func(t *testing.T) {
			out, err := Process(src, Options{Algorithm: alg})
			if err != nil {
				t.Fatalf("Process: %v", err)
			}

			img := pngDecode(t, out)

			// Dimensions must be preserved.
			b := img.Bounds()
			if b.Dx() != 64 || b.Dy() != 64 {
				t.Errorf("dimensions: got %dx%d, want 64x64", b.Dx(), b.Dy())
			}

			// Every pixel must be pure black or pure white.
			if !isBinary(img) {
				t.Error("output contains non-binary pixel values")
			}
		})
	}
}

func TestProcessAdjustmentsOnly(t *testing.T) {
	// Brightness+contrast+gamma without dithering should produce a valid PNG
	// of the same size (but not necessarily binary).
	src := pngEncode(t, makeGradient(32, 32))
	out, err := Process(src, Options{Brightness: 10, Contrast: 20, Gamma: 1.2})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	img := pngDecode(t, out)
	b := img.Bounds()
	if b.Dx() != 32 || b.Dy() != 32 {
		t.Errorf("unexpected dimensions: %dx%d", b.Dx(), b.Dy())
	}
}

// ── applyBrightness ───────────────────────────────────────────────────────────

func TestApplyBrightness(t *testing.T) {
	tests := []struct {
		name   string
		in     uint8
		n      int
		want   uint8
	}{
		// adj = 10/100*255 = 25.5; 100+25.5 = 125.5 → round → 126
		{"add 10", 100, 10, 126},
		// adj = -20/100*255 = -51; 200-51 = 149
		{"subtract 20", 200, -20, 149},
		// clamp high
		{"clamp to 255", 240, 50, 255},
		// clamp low
		{"clamp to 0", 10, -50, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			img := pixel1(tt.in, tt.in, tt.in, 255)
			applyBrightness(img, tt.n)
			if img.Pix[0] != tt.want {
				t.Errorf("R: got %d, want %d", img.Pix[0], tt.want)
			}
			if img.Pix[1] != tt.want || img.Pix[2] != tt.want {
				t.Errorf("G/B mismatch: G=%d B=%d", img.Pix[1], img.Pix[2])
			}
			if img.Pix[3] != 255 {
				t.Errorf("alpha changed: got %d", img.Pix[3])
			}
		})
	}
}

// ── applyContrast ─────────────────────────────────────────────────────────────

func TestApplyContrast(t *testing.T) {
	tests := []struct {
		name  string
		in    uint8
		n     int
		want  uint8
	}{
		// factor = 1.5; (100-128)*1.5+128 = -42+128 = 86
		{"contrast+50 dark pixel", 100, 50, 86},
		// factor = 1.5; (200-128)*1.5+128 = 108+128 = 236
		{"contrast+50 bright pixel", 200, 50, 236},
		// factor = 0.5; (200-128)*0.5+128 = 36+128 = 164
		{"contrast-50", 200, -50, 164},
		// midpoint 128 is invariant regardless of factor
		{"midpoint invariant", 128, 50, 128},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			img := pixel1(tt.in, tt.in, tt.in, 255)
			applyContrast(img, tt.n)
			if img.Pix[0] != tt.want {
				t.Errorf("got %d, want %d", img.Pix[0], tt.want)
			}
			if img.Pix[3] != 255 {
				t.Errorf("alpha changed: got %d", img.Pix[3])
			}
		})
	}
}

// ── applyGamma ────────────────────────────────────────────────────────────────

func TestApplyGamma(t *testing.T) {
	tests := []struct {
		name  string
		in    uint8
		gamma float64
		want  uint8
	}{
		// gamma=2.0, inv=0.5: round(pow(100/255, 0.5)*255) ≈ 160
		{"gamma 2.0, mid pixel", 100, 2.0, 160},
		// extremes are always preserved
		{"black is black", 0, 2.0, 0},
		{"white is white", 255, 2.0, 255},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			img := pixel1(tt.in, tt.in, tt.in, 255)
			applyGamma(img, tt.gamma)
			if img.Pix[0] != tt.want {
				t.Errorf("got %d, want %d", img.Pix[0], tt.want)
			}
		})
	}
}

// ── toGrayscale ───────────────────────────────────────────────────────────────

func TestToGrayscale(t *testing.T) {
	tests := []struct {
		name     string
		r, g, b  uint8
		wantGray uint8
	}{
		// pure red:   round(0.2126 * 255) = 54
		{"pure red", 255, 0, 0, 54},
		// pure green: round(0.7152 * 255) = 182
		{"pure green", 0, 255, 0, 182},
		// pure blue:  round(0.0722 * 255) = 18
		{"pure blue", 0, 0, 255, 18},
		{"gray passthrough", 128, 128, 128, 128},
		{"black", 0, 0, 0, 0},
		{"white", 255, 255, 255, 255},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			img := pixel1(tt.r, tt.g, tt.b, 255)
			toGrayscale(img)
			got := img.Pix[0]
			if got != tt.wantGray {
				t.Errorf("got %d, want %d", got, tt.wantGray)
			}
			// All channels must be equal after grayscale.
			if img.Pix[1] != got || img.Pix[2] != got {
				t.Errorf("channels unequal after grayscale: R=%d G=%d B=%d",
					img.Pix[0], img.Pix[1], img.Pix[2])
			}
			// Alpha must not change.
			if img.Pix[3] != 255 {
				t.Errorf("alpha changed: got %d", img.Pix[3])
			}
		})
	}
}

// ── clampU8 ───────────────────────────────────────────────────────────────────

func TestClampU8(t *testing.T) {
	if clampU8(-1) != 0 {
		t.Error("clampU8(-1): want 0")
	}
	if clampU8(256) != 255 {
		t.Error("clampU8(256): want 255")
	}
	if clampU8(127.5) != 128 {
		t.Errorf("clampU8(127.5): got %d, want 128", clampU8(127.5))
	}
}

// ── isNoOp ────────────────────────────────────────────────────────────────────

func TestIsNoOp(t *testing.T) {
	// Should be no-ops:
	for _, opts := range []Options{
		{},
		{Algorithm: None, Gamma: 1.0},
		{Algorithm: "", Gamma: 0}, // gamma 0 == 1.0
	} {
		if !isNoOp(opts) {
			t.Errorf("expected no-op: %+v", opts)
		}
	}

	// Should NOT be no-ops:
	for _, opts := range []Options{
		{Algorithm: Threshold},
		{Brightness: 10},
		{Contrast: -5},
		{Gamma: 2.0},
	} {
		if isNoOp(opts) {
			t.Errorf("expected active: %+v", opts)
		}
	}
}

// ── alpha preservation ────────────────────────────────────────────────────────

func TestAdjustmentsPreserveAlpha(t *testing.T) {
	img := pixel1(120, 80, 160, 77)
	applyBrightness(img, 10)
	applyContrast(img, 20)
	applyGamma(img, 1.5)
	toGrayscale(img)
	if img.Pix[3] != 77 {
		t.Errorf("alpha changed: got %d, want 77", img.Pix[3])
	}
}
