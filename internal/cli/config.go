package cli

import (
	"fmt"

	"github.com/ChaseBro/receiptd/internal/stub"
	"github.com/spf13/cobra"
)

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage receiptd configuration",
	Long:  `View and modify receiptd configuration settings.`,
}

var configShowCmd = &cobra.Command{
	Use:   "show",
	Short: "Show current configuration",
	Run: func(cmd *cobra.Command, args []string) {
		result := stub.GetConfig()
		
		if jsonOutput {
			PrintJSON(result)
			return
		}
		
		fmt.Println("⚙️  Configuration")
		fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
		fmt.Printf("Config file: %s\n\n", result.ConfigPath)
		
		for key, value := range result.Settings {
			fmt.Printf("  %s: %v\n", key, value)
		}
		
		fmt.Println("\n💡 Modify with: receiptd config set <key> <value>")
		
		// TODO: Implement config display
		// - Read from ~/.receiptd/config.yaml
		// - Display all settings
		// - Show computed/default values
	},
}

var configSetCmd = &cobra.Command{
	Use:   "set <key> <value>",
	Short: "Set a configuration value",
	Args:  cobra.ExactArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		key := args[0]
		value := args[1]
		
		result := stub.SetConfig(key, value)
		
		if jsonOutput {
			PrintJSON(result)
			return
		}
		
		fmt.Printf("✅ Configuration updated\n")
		fmt.Printf("   %s = %s\n", key, value)
		
		// TODO: Implement config setting
		// - Validate key/value
		// - Update config file
		// - Notify running server of changes
		// - Common keys:
		//   - default_printer
		//   - socket_path
		//   - tcp_port
		//   - log_level
	},
}

func init() {
	rootCmd.AddCommand(configCmd)
	configCmd.AddCommand(configShowCmd)
	configCmd.AddCommand(configSetCmd)
}
