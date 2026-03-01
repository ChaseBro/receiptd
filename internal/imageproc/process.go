package imageproc

import (
	"bytes"
	"image"
	"image/png"
	_ "image/jpeg"
)

// Algorithm names the dithering algorithm to apply.
type Algorithm string

const (
	None           Algorithm = "none"
	Threshold      Algorithm = "threshold"
	FloydSteinberg Algorithm = "floyd-steinberg"
	Atkinson       Algorithm = "atkinson"
	Bayer          Algorithm = "bayer"
	Hilbert        Algorithm = "hilbert"
	BlueNoise      Algorithm = "blue-noise"
)

// Options controls the image-processing pipeline.
// Zero value is a no-op: no adjustments, no dithering.
type Options struct {
	Algorithm  Algorithm // "none" = no-op (default)
	Brightness int       // -100 to 100; 0 = no change
	Contrast   int       // -100 to 100; 0 = no change
	Gamma      float64   // 0.5–2.5; 0 or 1.0 = no change
}

// Process decodes imgData (PNG or JPEG), applies brightness/contrast/gamma
// adjustments and the chosen dithering algorithm, then re-encodes as PNG.
// Returns the input bytes unchanged when opts is a zero-value / no-op.
func Process(imgData []byte, opts Options) ([]byte, error) {
	if isNoOp(opts) {
		return imgData, nil
	}

	img, _, err := image.Decode(bytes.NewReader(imgData))
	if err != nil {
		return nil, err
	}

	nrgba := toNRGBA(img)

	if opts.Brightness != 0 {
		applyBrightness(nrgba, opts.Brightness)
	}
	if opts.Contrast != 0 {
		applyContrast(nrgba, opts.Contrast)
	}
	g := opts.Gamma
	if g != 0 && g != 1.0 {
		applyGamma(nrgba, g)
	}

	var out image.Image = nrgba
	if opts.Algorithm != None && opts.Algorithm != "" {
		toGrayscale(nrgba)
		out = applyDither(nrgba, opts.Algorithm)
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, out); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// isNoOp reports whether opts requests no transformation at all.
func isNoOp(opts Options) bool {
	alg := opts.Algorithm
	if alg == "" {
		alg = None
	}
	gamma := opts.Gamma
	if gamma == 0 {
		gamma = 1.0
	}
	return alg == None && opts.Brightness == 0 && opts.Contrast == 0 && gamma == 1.0
}

// toNRGBA converts any image.Image to *image.NRGBA.
func toNRGBA(img image.Image) *image.NRGBA {
	if n, ok := img.(*image.NRGBA); ok {
		return n
	}
	b := img.Bounds()
	out := image.NewNRGBA(b)
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			out.Set(x, y, img.At(x, y))
		}
	}
	return out
}
