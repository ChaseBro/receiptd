package cli

import (
	"fmt"

	"github.com/ChaseBro/receiptd/internal/stub"
	"github.com/spf13/cobra"
)

var jobsCmd = &cobra.Command{
	Use:   "jobs",
	Short: "List print jobs",
	Long:  `List recent and active print jobs with their status.`,
	Run: func(cmd *cobra.Command, args []string) {
		result := stub.ListJobs()
		
		if jsonOutput {
			PrintJSON(result)
			return
		}
		
		fmt.Println("📋 Print Jobs")
		fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
		
		if len(result.Jobs) == 0 {
			fmt.Println("\nNo jobs found")
			return
		}
		
		for _, job := range result.Jobs {
			statusIcon := "⏳"
			switch job.Status {
			case "completed":
				statusIcon = "✅"
			case "failed":
				statusIcon = "❌"
			case "processing":
				statusIcon = "🔄"
			}
			
			fmt.Printf("%s %s | %s\n", statusIcon, job.ID, job.Status)
			fmt.Printf("   Printer: %s\n", job.PrinterID)
			fmt.Printf("   Created: %s\n", job.CreatedAt)
			if job.Message != "" {
				preview := job.Message
				if len(preview) > 50 {
					preview = preview[:47] + "..."
				}
				fmt.Printf("   Preview: %s\n", preview)
			}
			fmt.Println()
		}
		
		// TODO: Implement job listing
		// - Query server for job history
		// - Show active and recent jobs
		// - Display job status, timestamps
		// - Allow filtering by status, printer
	},
}

func init() {
	rootCmd.AddCommand(jobsCmd)
}
