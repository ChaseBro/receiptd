package imageproc

import (
	"image"
	"image/color"
	"math"

	"github.com/makeworld-the-better-one/dither/v2"
)

var bwPalette = []color.Color{color.Black, color.White}

// applyDither dispatches to the chosen algorithm and returns the result as
// image.Image. The input must already be grayscale.
func applyDither(img *image.NRGBA, alg Algorithm) image.Image {
	switch alg {
	case Threshold:
		applyThreshold(img)
		return img
	case FloydSteinberg:
		d := dither.NewDitherer(bwPalette)
		d.Matrix = dither.FloydSteinberg
		return d.Dither(img)
	case Atkinson:
		d := dither.NewDitherer(bwPalette)
		d.Matrix = dither.Atkinson
		return d.Dither(img)
	case Bayer:
		d := dither.NewDitherer(bwPalette)
		d.Mapper = dither.Bayer(8, 8, 1.0)
		return d.Dither(img)
	case Hilbert:
		applyHilbert(img)
		return img
	case BlueNoise:
		applyBlueNoise(img)
		return img
	default:
		return img
	}
}

// applyThreshold converts each pixel to black or white at midpoint 128.
// Input must be grayscale (R=G=B). Modifies img in place.
func applyThreshold(img *image.NRGBA) {
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := img.PixOffset(x, y)
			var v uint8
			if img.Pix[i] >= 128 {
				v = 255
			}
			img.Pix[i+0] = v
			img.Pix[i+1] = v
			img.Pix[i+2] = v
		}
	}
}

// applyHilbert applies 1-D error diffusion in row-major order (ported from
// photo-receipts applyHilbertDithering). Input must be grayscale.
func applyHilbert(img *image.NRGBA) {
	const threshold = 128.0
	const errorWeight = 0.5

	b := img.Bounds()
	var carry float64
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			i := img.PixOffset(x, y)
			adjusted := float64(img.Pix[i]) + carry
			var binary uint8
			if adjusted >= threshold {
				binary = 255
			}
			img.Pix[i+0] = binary
			img.Pix[i+1] = binary
			img.Pix[i+2] = binary
			carry = (adjusted - float64(binary)) * errorWeight
		}
	}
}

// applyBlueNoise applies hash-based multi-octave noise dithering (ported from
// photo-receipts applyBlueNoiseDithering). Input must be grayscale.
func applyBlueNoise(img *image.NRGBA) {
	b := img.Bounds()
	w := b.Max.X - b.Min.X
	h := b.Max.Y - b.Min.Y

	noiseMap := make([]float64, w*h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var noise, amplitude, maxVal float64
			amplitude = 1
			frequency := 1.0
			for octave := 0; octave < 3; octave++ {
				noise += amplitude * hashNoise(float64(x)*frequency, float64(y)*frequency, float64(octave))
				maxVal += amplitude
				amplitude *= 0.5
				frequency *= 2
			}
			noiseMap[y*w+x] = (noise/maxVal - 0.5) * 100
		}
	}

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := img.PixOffset(b.Min.X+x, b.Min.Y+y)
			adjusted := float64(img.Pix[i]) + noiseMap[y*w+x]
			var binary uint8
			if adjusted >= 128 {
				binary = 255
			}
			img.Pix[i+0] = binary
			img.Pix[i+1] = binary
			img.Pix[i+2] = binary
		}
	}
}

// hashNoise returns a pseudo-random value in [0,1) for the given x/y/seed.
func hashNoise(x, y, seed float64) float64 {
	h := math.Sin(x*12.9898+y*78.233+seed) * 43758.5453
	return h - math.Floor(h)
}
