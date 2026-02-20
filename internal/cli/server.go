package cli

import (
	"fmt"

	"github.com/ChaseBro/receiptd/internal/stub"
	"github.com/spf13/cobra"
)

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Start the receiptd server daemon",
	Long:  `Start the receiptd server daemon that listens for print requests.`,
	Run: func(cmd *cobra.Command, args []string) {
		result := stub.StartServer()
		
		if jsonOutput {
			PrintJSON(result)
		} else {
			fmt.Println("🚀 Starting receiptd server...")
			fmt.Printf("   Socket: %s\n", result.SocketPath)
			fmt.Printf("   TCP: %s\n", result.TCPAddress)
			fmt.Println("\n✅ Server started successfully")
			fmt.Println("   Use 'receiptd status' to check health")
		}
		
		// TODO: Implement actual server startup
		// - Create Unix socket at ~/.receiptd/receiptd.sock
		// - Listen on TCP 127.0.0.1:3099 as fallback
		// - Load configuration
		// - Initialize printer connections
		// - Start job queue processor
		// - Handle graceful shutdown
	},
}

var serverStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the receiptd server daemon",
	Run: func(cmd *cobra.Command, args []string) {
		result := stub.StopServer()
		
		if jsonOutput {
			PrintJSON(result)
		} else {
			fmt.Println("🛑 Stopping receiptd server...")
			fmt.Println("✅ Server stopped successfully")
		}
		
		// TODO: Implement server shutdown
		// - Send shutdown signal to running daemon
		// - Wait for graceful shutdown
		// - Clean up socket files
		// - Report any active jobs
	},
}

func init() {
	rootCmd.AddCommand(serverCmd)
	serverCmd.AddCommand(serverStopCmd)
}
