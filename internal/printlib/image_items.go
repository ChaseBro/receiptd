package printlib

import (
	"fmt"
	"os"
)

func init() {
	allItems = append(allItems,
		Item{
			Name:        "photo-test",
			Description: "Prints photo-sample.png with floyd-steinberg dithering",
			Kind:        KindTest,
			Mode:        ModeImage,
			Tags:        []string{"image", "photo", "dither"},
			ImageFn:     imagePhotoTest,
		},
	)
}

func imagePhotoTest() (path, caption string) {
	p, err := ImageAsset("photo-sample.png")
	if err != nil {
		// Return an empty path; the caller will see the empty string and can skip/log.
		fmt.Fprintf(os.Stderr, "photo-test: load asset: %v\n", err)
		return "", ""
	}
	return p, "photo-test sample"
}
