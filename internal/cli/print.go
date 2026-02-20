package cli

import (
	"fmt"
	"strings"

	"github.com/ChaseBro/receiptd/internal/stub"
	"github.com/spf13/cobra"
)

var (
	printerID string
	waitTime  int
)

var printCmd = &cobra.Command{
	Use:   "print <message>",
	Short: "Print a message to the receipt printer",
	Long: `Print a message to the configured receipt printer.
	
Examples:
  receiptd print "Hello, World!"
  receiptd print --printer tsp100-01 "Test print"
  receiptd print --wait 5 "Delayed print"`,
	Args: cobra.MinimumNArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		message := strings.Join(args, " ")
		
		result := stub.Print(message, printerID, waitTime)
		
		if jsonOutput {
			PrintJSON(result)
			return
		}
		
		// Human-readable output
		fmt.Printf("🖨️  Printing message...\n")
		if printerID != "" {
			fmt.Printf("   Printer: %s\n", printerID)
		} else {
			fmt.Printf("   Printer: %s (default)\n", result.PrinterID)
		}
		if waitTime > 0 {
			fmt.Printf("   Wait: %d seconds\n", waitTime)
		}
		fmt.Printf("   Job ID: %s\n", result.JobID)
		fmt.Println("\n✅ Print job submitted successfully")
		fmt.Printf("   Track with: receiptd jobs\n")
		
		// TODO: Implement actual printing
		// - Connect to receiptd server
		// - Submit print job with message
		// - Use specified printer or default
		// - Handle wait/delay if specified
		// - Return job ID for tracking
		// - Error handling:
		//   - Server not running → "Server not running. Run 'receiptd server'"
		//   - No printer configured → "No printer configured. Run 'receiptd printer discover'"
		//   - Printer offline → "Printer offline: <id>"
	},
}

func init() {
	rootCmd.AddCommand(printCmd)
	printCmd.Flags().StringVar(&printerID, "printer", "", "Printer ID to use")
	printCmd.Flags().IntVar(&waitTime, "wait", 0, "Wait time in seconds before printing")
}
