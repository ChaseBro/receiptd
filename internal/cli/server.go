package cli

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/ChaseBro/receiptd/internal/server"
	"github.com/spf13/cobra"
)

var (
	serverRequireAuth bool
)

var serverCmd = &cobra.Command{
	Use:   "server",
	Short: "Start the receiptd server (foreground)",
	Long: `Start the receiptd CloudPRNT server in the foreground. Use a process manager (launchd, systemd, etc.) to run it as a background service.

By default loopback callers (127.0.0.1, ::1) bypass auth — preserves zero-friction local UX. Pass --require-auth to force bearer-token auth on every /v1 request, which is what cloud deployments use.`,
	Run: func(cmd *cobra.Command, args []string) {
		runServer()
	},
}

var serverStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop a running receiptd server",
	Run: func(cmd *cobra.Command, args []string) {
		conn, err := net.DialTimeout("tcp", "127.0.0.1:3099", 1*time.Second)
		if err != nil {
			fmt.Println("Server not running")
			return
		}

		fmt.Println("Stopping receiptd server...")
		conn.Write([]byte(`{"command":"stop","payload":null}`))
		conn.Close()

		// Wait for the port to be released (up to 5s)
		for i := 0; i < 10; i++ {
			time.Sleep(500 * time.Millisecond)
			c, err := net.DialTimeout("tcp", "127.0.0.1:3099", 200*time.Millisecond)
			if err != nil {
				fmt.Println("Server stopped")
				return
			}
			c.Close()
		}

		fmt.Fprintln(os.Stderr, "warning: server may still be running")
	},
}

func runServer() {
	home, _ := os.UserHomeDir()
	cfg := server.DefaultConfig()
	cfg.DataDir = filepath.Join(home, ".receiptd")
	cfg.RequireAuthOnLoopback = serverRequireAuth

	d, err := server.NewDaemon(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("receiptd starting\n")
	fmt.Printf("  CloudPRNT : %s\n", cfg.CloudPRNTListen)
	fmt.Printf("  CLI       : %s\n", cfg.CLIListen)
	fmt.Printf("  Data      : %s\n", cfg.DataDir)
	fmt.Println("Press Ctrl+C to stop.")

	if err := d.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "server error: %v\n", err)
		os.Exit(1)
	}
}

func init() {
	rootCmd.AddCommand(serverCmd)
	serverCmd.AddCommand(serverStopCmd)
	serverCmd.Flags().BoolVar(&serverRequireAuth, "require-auth", false, "Require bearer-token auth even for loopback callers (public-mode simulation)")
}
