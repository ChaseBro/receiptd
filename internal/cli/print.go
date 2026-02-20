package cli

import (
	"fmt"
	"strings"
	"time"

	"github.com/ChaseBro/receiptd/internal/client"
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
		
		// Wait if specified
		if waitTime > 0 {
			fmt.Printf("⏳ Waiting %d seconds...\n", waitTime)
			time.Sleep(time.Duration(waitTime) * time.Second)
		}
		
		// Try to connect to real server first
		c := client.NewClient()
		
		if !c.IsServerRunning() {
			// Server not running - use stub
			if jsonOutput {
				fmt.Println(`{"error":"Server not running. Run 'receiptd server' first"}`)
				return
			}
			fmt.Println("⚠️  Server not running. Using stub mode.")
			result := stub.Print(message, printerID, 0)
			printStubResult(result)
			return
		}
		
		// Try real server
		resp, err := c.AddJob(printerID, message)
		if err != nil {
			// Server error - fall back to stub
			if jsonOutput {
				fmt.Println(`{"error":"Server error: ` + err.Error() + `"}`)
				return
			}
			fmt.Println("⚠️  Server error, using stub mode:", err)
			result := stub.Print(message, printerID, 0)
			printStubResult(result)
			return
		}
		
		// Success!
		if jsonOutput {
			PrintJSON(resp)
			return
		}
		
		fmt.Printf("🖨️  Printing message...\n")
		if printerID != "" {
			fmt.Printf("   Printer: %s\n", printerID)
		}
		fmt.Printf("   Job ID: %s\n", resp.Data)
		fmt.Println("\n✅ Print job submitted successfully")
	},
}

func printStubResult(result stub.PrintResult) {
	fmt.Printf("   Printer: %s (stub)\n", result.PrinterID)
	fmt.Printf("   Job ID: %s (stub)\n", result.JobID)
	fmt.Println("\n✅ Stub: job would be submitted")
}

func init() {
	rootCmd.AddCommand(printCmd)
	printCmd.Flags().StringVar(&printerID, "printer", "", "Printer ID to use")
	printCmd.Flags().IntVarP(&waitTime, "wait", "w", 0, "Wait time in seconds before printing")
}