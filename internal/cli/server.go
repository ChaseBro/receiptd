package cli

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/ChaseBro/receiptd/internal/server"
	"github.com/spf13/cobra"
)

const daemonEnv = "RECEIPTD_DAEMON_CHILD"

var daemonMode bool

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Start the receiptd server daemon",
	Long:  `Start the receiptd server daemon that listens for print requests.`,
	Run: func(cmd *cobra.Command, args []string) {
		if os.Getenv(daemonEnv) == "1" {
			// We're the background child — run the server.
			runServerDaemon()
			return
		}
		if daemonMode {
			spawnDaemon()
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

		if !jsonOutput {
			fmt.Println("🛑 Stopping receiptd server...")
		}

		conn.Write([]byte(`{"command":"stop","payload":null}`))
		conn.Close()

		// Wait for the port to be released (up to 5s)
		for i := 0; i < 10; i++ {
			time.Sleep(500 * time.Millisecond)
			c, err := net.DialTimeout("tcp", "127.0.0.1:3099", 200*time.Millisecond)
			if err != nil {
				if !jsonOutput {
					fmt.Println("✅ Server stopped")
				}
				return
			}
			c.Close()
		}

		fmt.Println("⚠️  Server may still be running")
	},
}

// spawnDaemon re-execs the binary as a detached background process and exits.
func spawnDaemon() {
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ Could not find executable: %v\n", err)
		os.Exit(1)
	}

	cmd := exec.Command(exe, "server")
	cmd.Env = append(os.Environ(), daemonEnv+"=1")
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "❌ Failed to start daemon: %v\n", err)
		os.Exit(1)
	}

	// Wait briefly for the server to be ready
	for i := 0; i < 10; i++ {
		time.Sleep(200 * time.Millisecond)
		c, err := net.DialTimeout("tcp", "127.0.0.1:3099", 100*time.Millisecond)
		if err == nil {
			c.Close()
			fmt.Printf("✅ Server started (pid %d)\n", cmd.Process.Pid)
			return
		}
	}

	fmt.Println("⚠️  Server may not have started")
}

func runServerForeground() {
	fmt.Println("🚀 Starting receiptd server...")

	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".receiptd")
	os.MkdirAll(dataDir, 0755)

	cfg := server.DefaultConfig()
	cfg.CloudPRNTListen = ":3000"
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
	go func() { <-sigCh; d.Stop() }()
	d.Run()
}

func runServerDaemon() {
	home, _ := os.UserHomeDir()
	dataDir := filepath.Join(home, ".receiptd")
	os.MkdirAll(dataDir, 0755)

	cfg := server.DefaultConfig()
	cfg.CloudPRNTListen = ":3000"
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
