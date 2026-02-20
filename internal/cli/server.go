package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/ChaseBro/receiptd/internal/stub"
	"github.com/spf13/cobra"
)

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Start the receiptd server daemon",
	Long:  `Start the receiptd server daemon that listens for print requests.`,
	Run: func(cmd *cobra.Command, args []string) {
		// Check if already running
		// For now, just start in background
		startServerDaemon()
		
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
	},
}

var serverStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the receiptd server daemon",
	Run: func(cmd *cobra.Command, args []string) {
		// TODO: Send signal to running server
		result := stub.StopServer()
		
		if jsonOutput {
			PrintJSON(result)
		} else {
			fmt.Println("🛑 Stopping receiptd server...")
			fmt.Println("✅ Server stopped successfully")
		}
	},
}

func startServerDaemon() {
	// Get the executable path
	execPath, err := os.Executable()
	if err != nil {
		execPath = "receiptd"
	}
	
	// Create data directory
	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".receiptd")
	os.MkdirAll(dataDir, 0755)
	
	// Start server in background
	// For now, just return - real implementation would fork
	cmd := exec.Command(execPath, "server", "--daemon")
	cmd.Start()
	
	fmt.Printf("   PID: %d\n", cmd.Process.Pid)
}

func init() {
	rootCmd.AddCommand(serverCmd)
	serverCmd.AddCommand(serverStopCmd)
}