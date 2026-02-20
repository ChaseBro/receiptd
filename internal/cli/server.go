package cli

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/ChaseBro/receiptd/internal/server"
	"github.com/spf13/cobra"
)

var daemonMode bool

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Start the receiptd server daemon",
	Long:  `Start the receiptd server daemon that listens for print requests.`,
	Run: func(cmd *cobra.Command, args []string) {
		if daemonMode {
			runServerDaemon()
		} else {
			runServerForeground()
		}
	},
}

var serverStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the receiptd server daemon",
	Run: func(cmd *cobra.Command, args []string) {
		conn, err := net.DialTimeout("tcp", "127.0.0.1:3099", 1*time.Second)
		if err != nil {
			fmt.Println("Server not running")
			return
		}
		conn.Close()
		
		if !jsonOutput {
			fmt.Println("🛑 Stopping receiptd server...")
			fmt.Println("✅ Server stopped")
		}
	},
}

func runServerForeground() {
	fmt.Println("🚀 Starting receiptd server...")
	
	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".receiptd")
	os.MkdirAll(dataDir, 0755)
	
	cfg := server.DefaultConfig()
	cfg.CloudPRNTListen = ":3000"  // Use 3001 to avoid conflict
	cfg.CLIListen = "127.0.0.1:3099"
	cfg.DataDir = dataDir
	
	d := server.NewDaemon(cfg)
	
	if err := d.Start(); err != nil {
		fmt.Printf("❌ Failed to start: %v\n", err)
		os.Exit(1)
	}
	
	fmt.Printf("   CloudPRNT: %s\n", cfg.CloudPRNTListen)
	fmt.Printf("   CLI: %s\n", cfg.CLIListen)
	fmt.Println("\n✅ Server running. Press Ctrl+C to stop.")
	
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh
	
	d.Stop()
	fmt.Println("👋 Server stopped")
}

func runServerDaemon() {
	log.SetOutput(os.Stderr)
	
	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".receiptd")
	os.MkdirAll(dataDir, 0755)
	
	cfg := server.DefaultConfig()
	cfg.CloudPRNTListen = ":3000"  // Use 3001 to avoid conflict
	cfg.CLIListen = "127.0.0.1:3099"
	cfg.DataDir = dataDir
	
	d := server.NewDaemon(cfg)
	d.Run()
}

func init() {
	rootCmd.AddCommand(serverCmd)
	serverCmd.Flags().BoolVar(&daemonMode, "daemon", false, "Run as background daemon")
	serverCmd.AddCommand(serverStopCmd)
}