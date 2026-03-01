package cli

import "github.com/spf13/cobra"

var fontFlag string // "" means no font override

// addFontFlag registers --font on cmd.
func addFontFlag(cmd *cobra.Command) {
	cmd.Flags().StringVar(&fontFlag, "font", "", "bitmap font slug to inject (see: receiptd fonts list)")
}
