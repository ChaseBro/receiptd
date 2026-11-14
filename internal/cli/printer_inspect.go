package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ChaseBro/receiptd/internal/printerconfig"
	"github.com/spf13/cobra"
)

var (
	inspectIP        string
	inspectAdminUser string
	inspectAdminPass string
	inspectPages     []string
)

var printerInspectCmd = &cobra.Command{
	Use:   "inspect",
	Short: "Read-only dump of the printer web UI's form fields (no changes made)",
	Long: `Log into a TSP100IV's web UI over the LAN and list the form fields on
one or more settings pages. Read-only: only GET requests after login, and
password values are redacted.

Useful for checking what a firmware exposes before scripting it — e.g.
whether any MQTT fields exist. (Per Star's docs, CloudPRNT MQTT Trigger
POST is enabled by the server's cloudprnt-setting.json, not by a web UI
field — see docs/cloudprnt-mqtt.md.)`,
	RunE: func(cmd *cobra.Command, args []string) error {
		return runInspect(cmd.Context())
	},
}

func runInspect(ctx context.Context) error {
	if inspectIP == "" {
		return errors.New("--ip required (e.g. --ip 192.168.1.38)")
	}
	if inspectAdminPass == "" {
		return errors.New("--admin-pass required (the printer web UI password)")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	sess, err := printerconfig.Dial(ctx, printerconfig.Credentials{
		Host: inspectIP, AdminUser: inspectAdminUser, AdminPass: inspectAdminPass,
	})
	if err != nil {
		return err
	}
	defer sess.Close()

	for _, path := range inspectPages {
		p, err := sess.Inspect(ctx, path)
		if err != nil {
			return err
		}
		fmt.Printf("== %s  (HTTP %d) %s\n", p.Path, p.Status, p.Title)
		for _, a := range p.Forms {
			fmt.Printf("   form action=%s\n", a)
		}
		for _, f := range p.Fields {
			fmt.Printf("   %-9s %-28s %s\n", fieldKind(f), f.Name, fieldValue(f))
		}
		if m := p.FieldsMatching("mqtt", "broker", "trigger"); len(m) > 0 {
			fmt.Printf("   ⚑ %d MQTT-looking field(s) on this page\n", len(m))
		}
		fmt.Println()
	}
	return nil
}

func fieldKind(f printerconfig.FormField) string {
	if f.Tag == "input" {
		return f.Type
	}
	return f.Tag
}

func fieldValue(f printerconfig.FormField) string {
	switch {
	case f.Type == "password":
		return "(redacted)"
	case f.Tag == "select":
		return fmt.Sprintf("selected=%q options=[%s]", f.Selected, strings.Join(f.Options, " "))
	case f.Type == "radio" || f.Type == "checkbox":
		mark := " "
		if f.Checked {
			mark = "x"
		}
		return fmt.Sprintf("[%s] %q", mark, f.Value)
	default:
		return fmt.Sprintf("%q", f.Value)
	}
}

func init() {
	printerInspectCmd.Flags().StringVar(&inspectIP, "ip", "", "Printer LAN address (e.g. 192.168.1.38)")
	printerInspectCmd.Flags().StringVar(&inspectAdminUser, "admin-user", printerconfig.DefaultAdminUser, "Printer admin username")
	printerInspectCmd.Flags().StringVar(&inspectAdminPass, "admin-pass", "", "Printer admin password (web UI login)")
	printerInspectCmd.Flags().StringSliceVar(&inspectPages, "page", []string{printerconfig.PageCloudPRNT}, "Web UI page path(s) to inspect (repeatable)")
	printerCmd.AddCommand(printerInspectCmd)
}
