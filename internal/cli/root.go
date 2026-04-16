package cli

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/ChaseBro/receiptd/internal/client"
	"github.com/spf13/cobra"
)

var (
	jsonOutput bool
	verbose    bool
	apiURL     string // --api flag
	apiKey     string // --api-key flag
)

// NewClient builds a client using the active CLI flags + env fallbacks +
// cached auth state. Resolution order: --api flag, RECEIPTD_API env,
// ~/.receiptd/auth.json. Same for the API key.
func NewClient() *client.Client {
	return client.NewClientFromConfig(client.ClientConfig{
		APIURL: ResolvedAPIURL(),
		APIKey: ResolvedAPIKey(),
	})
}

var rootCmd = &cobra.Command{
	Use:   "receiptd",
	Short: "receiptd - thermal printing CLI for humans and agents",
	Long: `receiptd is a thermal receipt printer daemon and CLI.
	
It provides a simple, agent-friendly interface for printing receipts,
managing printers, and monitoring print jobs.`,
}

func Execute() error {
	return rootCmd.Execute()
}

func init() {
	rootCmd.PersistentFlags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "Verbose output")
	rootCmd.PersistentFlags().StringVar(&apiURL, "api", "", "Remote receiptd API URL (overrides RECEIPTD_API). When set, bypasses the local daemon.")
	rootCmd.PersistentFlags().StringVar(&apiKey, "api-key", "", "Bearer token for remote API (overrides RECEIPTD_API_KEY).")
}

// OutputJSON outputs data as JSON if --json flag is set, otherwise uses human-readable format
func OutputJSON(data interface{}) error {
	if jsonOutput {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(data)
	}
	return nil
}

// PrintJSON is a helper for simple JSON output
func PrintJSON(data interface{}) {
	if err := OutputJSON(data); err != nil {
		fmt.Fprintf(os.Stderr, "Error encoding JSON: %v\n", err)
		os.Exit(1)
	}
}

// ErrorExit prints an error and exits
func ErrorExit(msg string, code int) {
	if jsonOutput {
		PrintJSON(map[string]interface{}{
			"error": msg,
			"code":  code,
		})
	} else {
		fmt.Fprintf(os.Stderr, "Error: %s\n", msg)
	}
	os.Exit(code)
}
