package server

import (
	"encoding/json"
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
	CLIListen       string
	CloudPRNTListen string
	DataDir         string
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
	
	// Start CLI listener
	var err error
	d.cliListener, err = net.Listen("tcp", d.config.CLIListen)
	if err != nil {
		return fmt.Errorf("listen on CLI address: %w", err)
	}
	
	d.wg.Add(1)
	go d.serveCLI()
	
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
		
		d.cliListener.(*net.TCPListener).SetDeadline(time.Now().Add(1 * time.Second))
		conn, err := d.cliListener.Accept()
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				continue
			}
			if netErr, ok := err.(net.Error); ok && !netErr.Temporary() {
				return
			}
			continue
		}
		
		d.wg.Add(1)
		go d.handleCLIConn(conn)
	}
}

// CLIRequest represents a CLI command request
type CLIRequest struct {
	Command string      `json:"command"`
	Payload interface{} `json:"payload"`
}

// CLIResponse represents a CLI command response
type CLIResponse struct {
	Status string      `json:"status"`
	Data   interface{} `json:"data,omitempty"`
	Error  string      `json:"error,omitempty"`
}

// handleCLIConn handles a CLI connection
func (d *Daemon) handleCLIConn(conn net.Conn) {
	defer d.wg.Done()
	defer conn.Close()
	
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return
	}
	
	// Parse request
	var req CLIRequest
	if err := json.Unmarshal(buf[:n], &req); err != nil {
		resp := CLIResponse{Status: "error", Error: "invalid request"}
		json.NewEncoder(conn).Encode(resp)
		return
	}
	
	log.Printf("[Daemon] CLI command: %s", req.Command)
	
	var resp CLIResponse
	switch req.Command {
	case "status":
		resp = CLIResponse{
			Status: "ok",
			Data: map[string]interface{}{
				"running":    true,
				"jobs_queued": d.queue.GetPendingCount(),
			},
		}
	case "add_job":
		payload, ok := req.Payload.(map[string]interface{})
		if !ok {
			resp = CLIResponse{Status: "error", Error: "invalid payload"}
			break
		}
		printerID, _ := payload["printerId"].(string)
		content, _ := payload["content"].(string)
		
		job := d.AddJob(printerID, content)
		resp = CLIResponse{
			Status: "ok",
			Data:   job.ID,
		}
	case "get_jobs":
		jobs := d.queue.GetAll()
		resp = CLIResponse{Status: "ok", Data: jobs}
	default:
		resp = CLIResponse{Status: "error", Error: "unknown command"}
	}
	
	json.NewEncoder(conn).Encode(resp)
}

// Stop stops the daemon gracefully
func (d *Daemon) Stop() error {
	log.Printf("[Daemon] Stopping...")
	close(d.stop)
	
	if d.httpServer != nil {
		d.httpServer.Close()
	}
	
	if d.cliListener != nil {
		d.cliListener.Close()
	}
	
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

// AddJob adds a job to the queue
func (d *Daemon) AddJob(printerID, content string) *Job {
	job := &Job{
		ID:        fmt.Sprintf("job-%d", time.Now().UnixNano()),
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