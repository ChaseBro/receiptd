package cli

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var (
	jsonOutput bool
	verbose    bool
)

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
