package cli

import (
	"github.com/ChaseBro/receiptd/internal/imageproc"
	"github.com/spf13/cobra"
)

var (
	ditherAlg  string  // none|threshold|floyd-steinberg|atkinson|bayer|hilbert|blue-noise
	brightness int     // -100 to 100
	contrast   int     // -100 to 100
	gamma      float64 // 0.5 to 2.5; 1.0 = no change
)

// addProcFlags registers the image-processing flags on cmd.
func addProcFlags(cmd *cobra.Command) {
	cmd.Flags().StringVar(&ditherAlg, "dither", "none",
		"Dithering algorithm: none|threshold|floyd-steinberg|atkinson|bayer|hilbert|blue-noise")
	cmd.Flags().IntVar(&brightness, "brightness", 0, "Brightness adjustment -100–100")
	cmd.Flags().IntVar(&contrast, "contrast", 0, "Contrast adjustment -100–100")
	cmd.Flags().Float64Var(&gamma, "gamma", 1.0, "Gamma correction 0.5–2.5 (1.0 = no change)")
}

// procOpts builds an imageproc.Options from the current flag values.
func procOpts() imageproc.Options {
	return imageproc.Options{
		Algorithm:  imageproc.Algorithm(ditherAlg),
		Brightness: brightness,
		Contrast:   contrast,
		Gamma:      gamma,
	}
}

// procActive reports whether any processing flag differs from its default.
func procActive() bool {
	return ditherAlg != string(imageproc.None) ||
		brightness != 0 ||
		contrast != 0 ||
		gamma != 1.0
}
