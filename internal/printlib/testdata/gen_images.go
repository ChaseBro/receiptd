//go:build ignore

// gen_images.go generates the test images committed to testdata/images/.
// Run with: go run internal/printlib/testdata/gen_images.go
package main

import (
	"image"
	"image/color"
	"image/png"
	"os"
)

func main() {
	genGradient("internal/printlib/testdata/images/gradient.png")
	genCheckerboard("internal/printlib/testdata/images/checkerboard.png")
}

func genGradient(path string) {
	const w, h = 576, 200
	img := image.NewGray(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			v := uint8(x * 255 / (w - 1))
			img.SetGray(x, y, color.Gray{Y: v})
		}
	}
	write(path, img)
}

func genCheckerboard(path string) {
	const w, h, sz = 576, 200, 8
	img := image.NewGray(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if ((x/sz)+(y/sz))%2 == 0 {
				img.SetGray(x, y, color.Gray{Y: 0})
			} else {
				img.SetGray(x, y, color.Gray{Y: 255})
			}
		}
	}
	write(path, img)
}

func write(path string, img image.Image) {
	f, err := os.Create(path)
	if err != nil {
		panic(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		panic(err)
	}
}
