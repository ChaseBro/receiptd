package imageproc

import (
	"image"
	"math"
)

// applyBrightness shifts each RGB channel by n/100*255, clamped to [0,255].
// n is in the range -100 to 100; 0 is a no-op.
func applyBrightness(img *image.NRGBA, n int) {
	adj := float64(n) / 100.0 * 255.0
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := img.PixOffset(x, y)
			img.Pix[i+0] = clampU8(float64(img.Pix[i+0]) + adj)
			img.Pix[i+1] = clampU8(float64(img.Pix[i+1]) + adj)
			img.Pix[i+2] = clampU8(float64(img.Pix[i+2]) + adj)
		}
	}
}

// applyContrast scales each RGB channel around midpoint 128 by factor=(n+100)/100.
// n is in the range -100 to 100; 0 is a no-op.
func applyContrast(img *image.NRGBA, n int) {
	factor := float64(n+100) / 100.0
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := img.PixOffset(x, y)
			img.Pix[i+0] = clampU8((float64(img.Pix[i+0])-128)*factor + 128)
			img.Pix[i+1] = clampU8((float64(img.Pix[i+1])-128)*factor + 128)
			img.Pix[i+2] = clampU8((float64(img.Pix[i+2])-128)*factor + 128)
		}
	}
}

// applyGamma applies gamma correction via a 256-entry LUT: out = (in/255)^(1/g) * 255.
// g==1.0 or g==0 is a no-op.
func applyGamma(img *image.NRGBA, g float64) {
	inv := 1.0 / g
	var lut [256]uint8
	for i := range lut {
		lut[i] = uint8(math.Round(math.Pow(float64(i)/255.0, inv) * 255.0))
	}
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := img.PixOffset(x, y)
			img.Pix[i+0] = lut[img.Pix[i+0]]
			img.Pix[i+1] = lut[img.Pix[i+1]]
			img.Pix[i+2] = lut[img.Pix[i+2]]
		}
	}
}

// toGrayscale converts in-place using BT.709 luminance weights.
func toGrayscale(img *image.NRGBA) {
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := img.PixOffset(x, y)
			r := float64(img.Pix[i+0])
			g := float64(img.Pix[i+1])
			bv := float64(img.Pix[i+2])
			gray := uint8(math.Round(0.2126*r + 0.7152*g + 0.0722*bv))
			img.Pix[i+0] = gray
			img.Pix[i+1] = gray
			img.Pix[i+2] = gray
		}
	}
}

// clampU8 rounds and clamps a float64 to [0, 255].
func clampU8(v float64) uint8 {
	v = math.Round(v)
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v)
}
