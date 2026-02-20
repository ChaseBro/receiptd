package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	
The server is started automatically if not running.
	
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
		
		c := client.NewClient()
		
		if !c.IsServerRunning() {
			// Server not running - start it automatically
			if !jsonOutput {
				fmt.Println("🚀 Starting server...")
			}
			if err := startServerAuto(); err != nil {
				if jsonOutput {
					fmt.Printf(`{"error":"Failed to start server: %s"}`, err)
					return
				}
				fmt.Printf("⚠️  Could not start server: %v\n", err)
				// Fall back to stub anyway
				result := stub.Print(message, printerID, 0)
				printStubResult(result)
				return
			}
			// Give server a moment to start
			time.Sleep(500 * time.Millisecond)
		}
		
		// Try real server
		resp, err := c.AddJob(printerID, message)
		if err != nil {
			// Server error - fall back to stub
			if jsonOutput {
				fmt.Printf(`{"error":"Server error: %s"}`, err)
				return
			}
			fmt.Printf("⚠️  Server error: %v\n", err)
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

// startServerAuto starts the server if not running
func startServerAuto() error {
	// Get the executable path
	execPath, err := os.Executable()
	if err != nil {
		execPath = "receiptd"
	}
	
	// Create data directory
	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".receiptd")
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return err
	}
	
	// Start server in background, ignore output
	cmd := exec.Command(execPath, "server", "--daemon")
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Start()
	
	// Don't wait - let it run in background
	return nil
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