package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/ChaseBro/receiptd/internal/cloudcprnt"
	"github.com/spf13/cobra"
)

// printer cloud-backed subcommands — these talk directly to the CF Worker
// admin API (HMAC-signed), gated on RECEIPTD_WORKER_URL +
// RECEIPTD_WORKER_HMAC_SECRET. Later these will route through Fly's REST
// API so end users don't need the HMAC secret.

func workerClientFromEnv() (*cloudcprnt.Client, error) {
	c := cloudcprnt.NewClientFromEnv()
	if c == nil {
		return nil, errors.New("worker not configured: set RECEIPTD_WORKER_URL and RECEIPTD_WORKER_HMAC_SECRET")
	}
	return c, nil
}

var printerStatusCmd = &cobra.Command{
	Use:   "status <printer-id>",
	Short: "Show the last-seen status for a printer (from cloud worker)",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		client, err := workerClientFromEnv()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(4)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		status, err := client.GetPrinterStatus(ctx, args[0])
		if errors.Is(err, cloudcprnt.ErrNoStatus) {
			fmt.Printf("Printer %s: no status yet (has never polled, or TTL expired)\n", args[0])
			os.Exit(0)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}

		if jsonOutput {
			PrintJSON(status)
			return
		}

		seen := time.UnixMilli(status.LastSeenAt)
		changed := time.UnixMilli(status.LastChangeAt)
		ago := time.Since(seen).Round(time.Second)

		fmt.Printf("Printer %s\n", args[0])
		fmt.Printf("  Last seen   : %s (%s ago)\n", seen.Format(time.RFC3339), ago)
		fmt.Printf("  Last change : %s\n", changed.Format(time.RFC3339))
		if status.StatusCode != "" {
			fmt.Printf("  Status code : %s\n", status.StatusCode)
		}
		if status.MAC != "" {
			fmt.Printf("  MAC         : %s\n", status.MAC)
		}
		if status.ClientType != "" {
			fmt.Printf("  Model       : %s\n", status.ClientType)
		}
		if status.ClientVersion != "" {
			fmt.Printf("  Firmware    : %s\n", status.ClientVersion)
		}
		if status.PrintWidth > 0 {
			fmt.Printf("  Print width : %g (HorizontalRes %g)\n", status.PrintWidth, status.HorizontalRes)
		}
		if status.PrintingInProgress {
			fmt.Println("  State       : printing")
		}
	},
}

func init() {
	printerCmd.AddCommand(printerStatusCmd)
}
