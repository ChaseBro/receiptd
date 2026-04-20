package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/ChaseBro/receiptd/internal/printerconfig"
	"github.com/spf13/cobra"
)

var (
	pairIP         string
	pairAdminUser  string
	pairAdminPass  string
	pairLabel      string
	pairServerURL  string
	pairPollSec    int
	pairNoRestart  bool
	pairPrinterID  string
	pairDryRun     bool
)

var printerPairCmd = &cobra.Command{
	Use:   "pair",
	Short: "Pair a Star TSP100IV printer with the cloud (CloudPRNT auto-config)",
	Long: `Mint a per-printer credential, push the CloudPRNT config to the
printer's web UI over the LAN, and restart it. Prints a pasteable fallback
block if the LAN push fails (unreachable printer, firmware variant, etc.).

Requires RECEIPTD_WORKER_URL + RECEIPTD_WORKER_HMAC_SECRET in the
environment — the pairing operation stores the printer secret in the
cloud worker's KV.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runPair(cmd.Context())
	},
}

func runPair(ctx context.Context) error {
	if pairIP == "" {
		return errors.New("--ip required (e.g. --ip 192.168.1.38)")
	}
	if pairAdminPass == "" {
		return errors.New("--admin-pass required (the printer web UI password)")
	}

	worker, err := workerClientFromEnv()
	if err != nil {
		return err
	}

	printerID := pairPrinterID
	if printerID == "" {
		printerID = newPrinterID(pairLabel)
	}
	secret, err := newPrinterSecret()
	if err != nil {
		return fmt.Errorf("mint secret: %w", err)
	}

	serverURL := pairServerURL
	if serverURL == "" {
		serverURL = strings.TrimRight(worker.BaseURL(), "/") + "/cprnt/" + printerID
	}

	if pairDryRun {
		fmt.Println("dry-run — no changes made")
		fmt.Printf("  printer id : %s\n", printerID)
		fmt.Printf("  secret     : %s (would upload to worker)\n", secret)
		fmt.Printf("  server URL : %s (would push to printer)\n", serverURL)
		return nil
	}

	// Step 1: store the secret on the worker FIRST — if this fails, the
	// printer never gets a config it can't authenticate with.
	putCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	if err := worker.PutPrinterSecret(putCtx, printerID, secret); err != nil {
		cancel()
		return fmt.Errorf("store secret in worker: %w", err)
	}
	cancel()
	fmt.Printf("✓ stored secret for %s on worker\n", printerID)

	// Step 2: push to printer web UI.
	settings := printerconfig.CloudPRNTSettings{
		Enable:         true,
		ServerURL:      serverURL,
		PollingSec:     pairPollSec,
		HTTPTimeoutSec: 60,
		Username:       printerID,
		Password:       secret,
	}
	if err := pushToPrinter(ctx, settings); err != nil {
		fmt.Fprintf(os.Stderr, "\n⚠ LAN push failed: %v\n\n", err)
		printPasteFallback(settings)
		return fmt.Errorf("LAN push failed (fallback shown above)")
	}
	fmt.Printf("✓ pushed config to printer at %s\n", pairIP)

	if pairNoRestart {
		fmt.Println("  (skipped save+restart per --no-restart; run save from the printer UI to apply)")
	} else {
		fmt.Printf("✓ save+restart triggered — printer will reboot in ~10s\n")
	}

	fmt.Printf("\nPaired printer %s.\n", printerID)
	fmt.Printf("  Check status in 30–60s with:\n")
	fmt.Printf("    receiptd printer status %s\n", printerID)
	return nil
}

func pushToPrinter(ctx context.Context, settings printerconfig.CloudPRNTSettings) error {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	sess, err := printerconfig.Dial(dialCtx, printerconfig.Credentials{
		Host:      pairIP,
		AdminUser: pairAdminUser,
		AdminPass: pairAdminPass,
	})
	if err != nil {
		return err
	}
	defer sess.Close()

	if err := sess.ApplyCloudPRNT(dialCtx, settings); err != nil {
		return err
	}
	if pairNoRestart {
		return nil
	}
	return sess.SaveAndRestart(dialCtx)
}

func printPasteFallback(s printerconfig.CloudPRNTSettings) {
	fmt.Println("Paste the following into the printer web UI")
	fmt.Println("(Network Configuration → CloudPRNT → Submit → then Save → Restart):")
	fmt.Println()
	fmt.Printf("  CloudPRNT Service         ENABLE\n")
	fmt.Printf("  Server URL                %s\n", s.ServerURL)
	fmt.Printf("  Polling time (Sec.)       %d\n", s.PollingSec)
	fmt.Printf("  HTTP Response Timeout     %d\n", s.HTTPTimeoutSec)
	fmt.Printf("  User Name                 %s\n", s.Username)
	fmt.Printf("  Password                  %s\n", s.Password)
	fmt.Println()
}

// newPrinterID returns "printer-<slug>-<4hex>" if a label is provided,
// "printer-<6hex>" otherwise. Kept readable for logs and paste-block
// output.
func newPrinterID(label string) string {
	suffix := make([]byte, 3)
	rand.Read(suffix)
	if label == "" {
		h := make([]byte, 3)
		rand.Read(h)
		return "printer-" + hex.EncodeToString(h)
	}
	return "printer-" + slugify(label) + "-" + hex.EncodeToString(suffix)[:4]
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slugify(s string) string {
	s = strings.ToLower(s)
	s = slugRe.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		return "p"
	}
	if len(s) > 24 {
		s = s[:24]
	}
	return s
}

// newPrinterSecret returns a 24-byte (48-hex-char) random string, well
// under the printer's 63-char password limit.
func newPrinterSecret() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "rdp_" + hex.EncodeToString(b), nil
}

func init() {
	printerPairCmd.Flags().StringVar(&pairIP, "ip", "", "Printer LAN address (e.g. 192.168.1.38)")
	printerPairCmd.Flags().StringVar(&pairAdminUser, "admin-user", printerconfig.DefaultAdminUser, "Printer admin username")
	printerPairCmd.Flags().StringVar(&pairAdminPass, "admin-pass", "", "Printer admin password (web UI login)")
	printerPairCmd.Flags().StringVar(&pairLabel, "label", "", "Friendly label (used in the printer id slug)")
	printerPairCmd.Flags().StringVar(&pairServerURL, "server-url", "", "Override CloudPRNT URL (default: worker URL + /cprnt/<id>)")
	printerPairCmd.Flags().StringVar(&pairPrinterID, "id", "", "Override generated printer id")
	printerPairCmd.Flags().IntVar(&pairPollSec, "poll-interval", 5, "Polling interval (seconds, 1-7200)")
	printerPairCmd.Flags().BoolVar(&pairNoRestart, "no-restart", false, "Apply config but don't reboot the printer")
	printerPairCmd.Flags().BoolVar(&pairDryRun, "dry-run", false, "Print the plan without making any changes")
	printerCmd.AddCommand(printerPairCmd)
}
