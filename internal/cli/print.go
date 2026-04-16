package cli

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ChaseBro/receiptd/internal/client"
	"github.com/ChaseBro/receiptd/internal/fontlib"
	"github.com/ChaseBro/receiptd/internal/imageproc"
	"github.com/ChaseBro/receiptd/internal/render"
	"github.com/ChaseBro/receiptd/internal/stub"
	"github.com/spf13/cobra"
)

var (
	printerID  string
	waitTime   int
	dryRun     bool
	staged     bool
	imagePath  string
	renderHTML string
	renderFile string
)

var printCmd = &cobra.Command{
	Use:   "print [message|-]",
	Short: "Print a message to the receipt printer",
	Long: `Print a message to the configured receipt printer.

The server is started automatically if not running.

Use - or a pipe to read markup from stdin (avoids shell quoting issues):
  receiptd print -
  echo '[align: center]Hello' | receiptd print -
  receiptd print - <<'EOF'
  [align: center]Hello
  EOF

Examples:
  receiptd print 'Hello, World!'
  receiptd print --printer tsp100-01 'Test print'
  receiptd print '[bold: on]Important[bold: off]'`,
	Args: cobra.ArbitraryArgs,
	Run: func(cmd *cobra.Command, args []string) {
		// Load --render-file into renderHTML before any other processing.
		if renderFile != "" {
			data, err := os.ReadFile(renderFile)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error reading --render-file: %v\n", err)
				os.Exit(1)
			}
			renderHTML = string(data)
		}

		// Claim stdin for --render before the message reader can consume it.
		if renderHTML == "-" {
			data, err := io.ReadAll(os.Stdin)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error reading stdin for --render: %v\n", err)
				os.Exit(1)
			}
			renderHTML = strings.TrimRight(string(data), "\n")
		}

		var message string
		// When --render is set, message comes from positional args only (not stdin).
		if renderHTML != "" {
			message = strings.Join(args, " ")
		} else {
			readStdin := len(args) == 0 || (len(args) == 1 && args[0] == "-")
			if !readStdin {
				// Check if stdin is a pipe even without explicit "-"
				if stat, err := os.Stdin.Stat(); err == nil {
					readStdin = (stat.Mode() & os.ModeCharDevice) == 0
				}
			}
			if readStdin {
				data, err := io.ReadAll(os.Stdin)
				if err != nil {
					fmt.Fprintf(os.Stderr, "Error reading stdin: %v\n", err)
					os.Exit(1)
				}
				message = strings.TrimRight(string(data), "\n")
			} else {
				message = strings.Join(args, " ")
			}
		}

		// Resolve image path to absolute before sending to server
		resolvedImage := ""
		if imagePath != "" && renderHTML != "" {
			fmt.Fprintf(os.Stderr, "Error: --image, --render, and --render-file are mutually exclusive\n")
			os.Exit(1)
		}
		if imagePath != "" {
			abs, err := filepath.Abs(imagePath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error resolving image path: %v\n", err)
				os.Exit(1)
			}
			if _, err := os.Stat(abs); err != nil {
				fmt.Fprintf(os.Stderr, "Image file not found: %s\n", abs)
				os.Exit(1)
			}
			resolvedImage = abs
		}

		// Apply image processing to --image file when any proc flag is set.
		if resolvedImage != "" && procActive() {
			raw, err := os.ReadFile(resolvedImage)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error reading image: %v\n", err)
				os.Exit(1)
			}
			processed, err := imageproc.Process(raw, procOpts())
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error processing image: %v\n", err)
				os.Exit(1)
			}
			savedPath, err := render.SaveRender(render.DataDir(), processed)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error saving processed image: %v\n", err)
				os.Exit(1)
			}
			resolvedImage = savedPath
		}

		// Render HTML to PNG when --render is set.
		if renderHTML != "" {
			html := renderHTML
			if fontFlag != "" {
				var err error
				html, err = fontlib.InjectFont(html, fontFlag, render.DataDir())
				if err != nil {
					fmt.Fprintf(os.Stderr, "Error: %v\n", err)
					os.Exit(1)
				}
			}
			if !jsonOutput {
				fmt.Fprintf(os.Stderr, "Rendering HTML at %dpx...\n", render.PrinterWidth)
			}
			png, err := render.HTMLToPNG(html, render.PrinterWidth)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: render failed: %v\n", err)
				fmt.Fprintf(os.Stderr, "Make sure Chrome or Chromium is installed.\n")
				os.Exit(1)
			}
			png, err = imageproc.Process(png, procOpts())
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error processing rendered image: %v\n", err)
				os.Exit(1)
			}
			saved, err := render.SaveRender(render.DataDir(), png)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error saving rendered image: %v\n", err)
				os.Exit(1)
			}
			resolvedImage = saved
		}

		if dryRun {
			fmt.Println(message)
			if resolvedImage != "" {
				fmt.Printf("[image: %s]\n", resolvedImage)
			}
			return
		}

		// Wait if specified
		if waitTime > 0 {
			fmt.Printf("⏳ Waiting %d seconds...\n", waitTime)
			time.Sleep(time.Duration(waitTime) * time.Second)
		}
		
		c := NewClient()

		if !c.IsServerRunning() {
			// In HTTP mode we cannot auto-start a remote daemon — fail fast.
			if c.CurrentMode() == client.ModeHTTP {
				ErrorExit("remote API not reachable (check --api / RECEIPTD_API)", 1)
			}
			// Server not running - start it automatically (local only)
			if !jsonOutput {
				fmt.Println("🚀 Starting server...")
			}
			if err := startServerAuto(); err != nil {
				if jsonOutput {
					fmt.Printf(`{"error":"Failed to start server: %s"}`, err)
					return
				}
				fmt.Printf("⚠️  Could not start server: %v\n", err)
				result := stub.Print(message, printerID, 0)
				printStubResult(result)
				return
			}
		}
		
		// Try real server
		resp, err := c.AddJob(printerID, message, resolvedImage, staged)
		if err != nil {
			// Server error - fall back to stub
			if jsonOutput {
				fmt.Printf(`{"error":"Server error: %s"}`, err)
				return
			}
			fmt.Printf("⚠️  Server error: %v\n", err)
			result := stub.Print(message, printerID, 0)
			printStubResult(result)
			return
		}
		
		// Success!
		if jsonOutput {
			PrintJSON(resp)
			return
		}
		
		if staged {
			fmt.Printf("📋 Job staged (held in queue, not sent to printer)\n")
		} else {
			fmt.Printf("🖨️  Printing message...\n")
		}
		if printerID != "" {
			fmt.Printf("   Printer: %s\n", printerID)
		}
		fmt.Printf("   Job ID: %s\n", resp.Data)
		if staged {
			fmt.Println("\n✅ Job staged successfully")
		} else {
			fmt.Println("\n✅ Print job submitted successfully")
		}
	},
}

// startServerAuto starts the server in the background and waits until it's ready.
func startServerAuto() error {
	execPath, err := os.Executable()
	if err != nil {
		execPath = "receiptd"
	}

	cmd := exec.Command(execPath, "server")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	for i := 0; i < 15; i++ {
		time.Sleep(200 * time.Millisecond)
		if c, err := net.DialTimeout("tcp", "127.0.0.1:3099", 100*time.Millisecond); err == nil {
			c.Close()
			return nil
		}
	}
	return fmt.Errorf("server did not start in time")
}

func printStubResult(result stub.PrintResult) {
	fmt.Printf("   Printer: %s (stub)\n", result.PrinterID)
	fmt.Printf("   Job ID: %s (stub)\n", result.JobID)
	fmt.Println("\n✅ Stub: job would be submitted")
}

func init() {
	rootCmd.AddCommand(printCmd)
	printCmd.Flags().StringVar(&printerID, "printer", "", "Printer ID to use")
	printCmd.Flags().IntVarP(&waitTime, "wait", "w", 0, "Wait time in seconds before printing")
	printCmd.Flags().BoolVar(&dryRun, "dry-run", false, "Resolve and print the message without contacting the server")
	printCmd.Flags().BoolVar(&staged, "staged", false, "Queue the job on the server but do not send to printer")
	printCmd.Flags().StringVar(&imagePath, "image", "", "Path to image file to print (PNG, JPEG, or BMP)")
	printCmd.Flags().StringVar(&renderHTML, "render", "", "HTML to render to an image and print (use - for stdin)")
	printCmd.Flags().StringVar(&renderFile, "render-file", "", "Path to HTML file to render and print")
	addProcFlags(printCmd)
	addFontFlag(printCmd)
}