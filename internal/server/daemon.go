package server

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// Config holds server configuration
type Config struct {
	// CLIListen is the address for CLI commands (e.g., "127.0.0.1:3099")
	CLIListen string
	
	// CloudPRNTListen is the address for printer connections (e.g., ":3000")
	CloudPRNTListen string
	
	// DataDir is where to store data
	DataDir string
}

// DefaultConfig returns sensible defaults
func DefaultConfig() *Config {
	return &Config{
		CLIListen:       "127.0.0.1:3099",
		CloudPRNTListen: ":3000",
		DataDir:         os.ExpandEnv("$HOME/.receiptd"),
	}
}

// Daemon is the main receiptd server
type Daemon struct {
	config      *Config
	queue       *Queue
	printers    *PrinterRegistry
	httpServer  *http.Server
	cliListener net.Listener
	ready       chan struct{}
	stop        chan struct{}
	wg          sync.WaitGroup
}

// NewDaemon creates a new daemon
func NewDaemon(cfg *Config) *Daemon {
	if cfg == nil {
		cfg = DefaultConfig()
	}
	
	return &Daemon{
		config:   cfg,
		queue:    NewQueue(),
		printers: NewPrinterRegistry(),
		ready:    make(chan struct{}),
		stop:     make(chan struct{}),
	}
}

// Start starts the daemon
func (d *Daemon) Start() error {
	log.Printf("[Daemon] Starting receiptd server...")
	log.Printf("[Daemon] CloudPRNT: %s", d.config.CloudPRNTListen)
	log.Printf("[Daemon] CLI: %s", d.config.CLIListen)
	
	// Ensure data directory exists
	if err := os.MkdirAll(d.config.DataDir, 0755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	
	// Start CloudPRNT HTTP server
	cloudprntHandler := NewCloudPRNTHandler(d.queue, "")
	d.httpServer = &http.Server{
		Addr:    d.config.CloudPRNTListen,
		Handler: cloudprntHandler,
	}
	
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		log.Printf("[Daemon] CloudPRNT server listening on %s", d.config.CloudPRNTListen)
		if err := d.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("[Daemon] CloudPRNT server error: %v", err)
		}
	}()
	
	// Start CLI listener (for receiptd print commands)
	var err error
	d.cliListener, err = net.Listen("tcp", d.config.CLIListen)
	if err != nil {
		return fmt.Errorf("listen on CLI address: %w", err)
	}
	
	d.wg.Add(1)
	go d.serveCLI()
	
	// Signal ready
	close(d.ready)
	log.Printf("[Daemon] Ready")
	
	return nil
}

// serveCLI handles CLI command connections
func (d *Daemon) serveCLI() {
	defer d.wg.Done()
	
	for {
		select {
		case <-d.stop:
			return
		default:
		}
		
		d.cliListener.SetDeadline(time.Now().Add(1 * time.Second))
		conn, err := d.cliListener.Accept()
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue // Normal timeout, keep looping
			}
			if netErr, ok := err.(net.Error); ok && !netErr.Temporary() {
				return // Not a temporary error, exit
			}
			continue
		}
		
		d.wg.Add(1)
		go d.handleCLIConn(conn)
	}
}

// TODO: Implement CLI protocol handler
// For now, this is a placeholder that echoes back what's sent
func (d *Daemon) handleCLIConn(conn net.Conn) {
	defer d.wg.Done()
	defer conn.Close()
	
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return
	}
	
	// Parse command (simple JSON for now)
	// In real implementation, this would be a proper protocol
	log.Printf("[Daemon] CLI command: %s", string(buf[:n]))
	
	// Echo back a simple response for now
	response := []byte(`{"status":"ok"}`)
	conn.Write(response)
}

// Stop stops the daemon gracefully
func (d *Daemon) Stop() error {
	log.Printf("[Daemon] Stopping...")
	close(d.stop)
	
	// Close HTTP server
	if d.httpServer != nil {
		d.httpServer.Close()
	}
	
	// Close CLI listener
	if d.cliListener != nil {
		d.httpServer.Close()
	}
	
	// Wait for all goroutines
	d.wg.Wait()
	
	log.Printf("[Daemon] Stopped")
	return nil
}

// WaitForReady blocks until the daemon is ready
func (d *Daemon) WaitForReady() {
	<-d.ready
}

// Queue returns the job queue
func (d *Daemon) Queue() *Queue {
	return d.queue
}

// Printers returns the printer registry
func (d *Daemon) Printers() *PrinterRegistry {
	return d.printers
}

// AddJob adds a job to the queue (called by CLI)
func (d *Daemon) AddJob(printerID, content string) *Job {
	job := &Job{
		ID:        fmt.Sprintf("job-%d", time.Now().Unix()),
		PrinterID: printerID,
		Content:   content,
		Status:    JobStatusPending,
		CreatedAt: time.Now(),
	}
	d.queue.Add(job)
	log.Printf("[Daemon] Job added: %s", job.ID)
	return job
}

// Run starts the daemon and waits for shutdown
func (d *Daemon) Run() error {
	if err := d.Start(); err != nil {
		return err
	}
	
	// Wait for interrupt signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	
	select {
	case sig := <-sigCh:
		log.Printf("[Daemon] Received signal: %v", sig)
	case <-d.stop:
	}
	
	return d.Stop()
}

// IsServerRunning checks if a server is already running on the CLI port
func IsServerRunning(addr string) bool {
	conn, err := net.DialTimeout("tcp", addr, 500*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}