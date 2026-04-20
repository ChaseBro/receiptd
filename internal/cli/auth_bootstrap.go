package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ChaseBro/receiptd/internal/db"
	"github.com/ChaseBro/receiptd/internal/services"
	"github.com/rs/zerolog"
	"github.com/spf13/cobra"
)

// `receiptd auth bootstrap-key` exists for one purpose: minting the very
// first API key on a fresh public-mode deployment. The normal
// `auth keys create` path goes through /v1/auth/keys, which requires auth —
// so a new deployment has no way to mint its first key. This command opens
// the on-disk SQLite DB directly and writes a key record, bypassing HTTP
// auth entirely. SSH-gated by design: you already need shell access to the
// host to run it.

var (
	bootstrapSubject string
	bootstrapLabel   string
	bootstrapScopes  []string
	bootstrapDataDir string
)

var authBootstrapCmd = &cobra.Command{
	Use:   "bootstrap-key",
	Short: "Mint the first API key on a fresh deployment (requires shell access to the host)",
	Long: `Mint an API key by writing directly to the SQLite database — bypassing
HTTP auth. Intended for bootstrapping a public-mode deployment where
there is no existing key to authenticate against /v1/auth/keys. Run this
via 'fly ssh console' (or equivalent) on the host.

After bootstrap, use the normal 'receiptd auth keys create' over HTTP.`,
	Run: func(cmd *cobra.Command, args []string) {
		dir := bootstrapDataDir
		if dir == "" {
			home, _ := os.UserHomeDir()
			dir = filepath.Join(home, ".receiptd")
		}

		database, err := db.Open(dir)
		if err != nil {
			ErrorExit(fmt.Sprintf("open db at %s: %v", dir, err), 1)
		}
		defer database.Close()

		svc := services.NewAPIKeys(database, "live", zerolog.Nop())
		minted, err := svc.Mint(context.Background(), services.MintInput{
			Subject: bootstrapSubject,
			Label:   bootstrapLabel,
			Scopes:  bootstrapScopes,
		})
		if err != nil {
			ErrorExit(fmt.Sprintf("mint: %v", err), 1)
		}

		if jsonOutput {
			fmt.Printf(`{"secret":%q,"prefix":%q,"subject":%q,"scopes":%q}`+"\n",
				minted.Secret, minted.Key.ID, minted.Key.Subject, minted.Key.Scopes)
			return
		}
		fmt.Printf("API key minted. Store this secret — it will not be shown again:\n\n")
		fmt.Printf("  %s\n\n", minted.Secret)
		fmt.Printf("  Subject : %s\n", minted.Key.Subject)
		fmt.Printf("  Prefix  : %s\n", minted.Key.ID)
		fmt.Printf("  Scopes  : %s\n", strings.ReplaceAll(minted.Key.Scopes, " ", ", "))
	},
}

func init() {
	authBootstrapCmd.Flags().StringVar(&bootstrapSubject, "subject", "bootstrap", "Subject (owner identity) for the key")
	authBootstrapCmd.Flags().StringVar(&bootstrapLabel, "label", "", "Friendly label")
	authBootstrapCmd.Flags().StringSliceVar(&bootstrapScopes, "scope", []string{"admin"}, "Scopes (can repeat)")
	authBootstrapCmd.Flags().StringVar(&bootstrapDataDir, "data-dir", "", "Data dir containing receiptd.db (default: $HOME/.receiptd)")
	authCmd.AddCommand(authBootstrapCmd)
}
