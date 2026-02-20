package cli

import (
	"fmt"

	"github.com/ChaseBro/receiptd/internal/stub"
	"github.com/spf13/cobra"
)

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check receiptd server health",
	Long:  `Check the health and status of the receiptd server daemon.`,
	Run: func(cmd *cobra.Command, args []string) {
		status := stub.GetStatus()
		
		if jsonOutput {
			PrintJSON(status)
			return
		}
		
		// Human-readable output
		fmt.Println("📊 receiptd Status")
		fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
		
		if status.Running {
			fmt.Println("Status: ✅ Running")
		} else {
			fmt.Println("Status: ❌ Stopped")
			fmt.Println("\n💡 Run 'receiptd server' to start")
			return
		}
		
		fmt.Printf("Uptime: %s\n", status.Uptime)
		fmt.Printf("Version: %s\n", status.Version)
		fmt.Printf("Socket: %s\n", status.SocketPath)
		fmt.Printf("TCP: %s\n", status.TCPAddress)
		fmt.Printf("\nPrinters: %d configured, %d online\n", 
			status.PrintersConfigured, status.PrintersOnline)
		fmt.Printf("Jobs: %d queued, %d processing\n", 
			status.JobsQueued, status.JobsProcessing)
		
		// TODO: Implement actual status check
		// - Connect to server via Unix socket or TCP
		// - Query server for real status
		// - Check printer connectivity
		// - Report job queue status
		// - Show any errors or warnings
	},
}

func init() {
	rootCmd.AddCommand(statusCmd)
}
