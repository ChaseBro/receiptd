package server

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/rs/zerolog"
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
	logger     zerolog.Logger
}

// NewDaemon creates a new daemon
func NewDaemon(cfg *Config) *Daemon {
	if cfg == nil {
		cfg = DefaultConfig()
	}

	// Setup logger
	logFile := filepath.Join(cfg.DataDir, "receiptd.log")
	os.MkdirAll(filepath.Dir(logFile), 0755)
	
	f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	var logger zerolog.Logger
	if err != nil {
		logger = zerolog.New(os.Stderr).With().Timestamp().Str("module", "daemon").Logger()
	} else {
		logger = zerolog.New(f).With().Timestamp().Str("module", "daemon").Logger()
	}

	return &Daemon{
		config:   cfg,
		queue:    NewQueue(),
		printers: NewPrinterRegistry(),
		ready:    make(chan struct{}),
		stop:     make(chan struct{}),
		logger:   logger,
	}
}

// Start starts the daemon
func (d *Daemon) Start() error {
	d.logger.Info().Msg("Starting receiptd server")
	d.logger.Info().Str("cloudprnt", d.config.CloudPRNTListen).Msg("CloudPRNT listen address")
	d.logger.Info().Str("cli", d.config.CLIListen).Msg("CLI listen address")

	// Ensure data directory exists
	if err := os.MkdirAll(d.config.DataDir, 0755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}

	// Start CloudPRNT HTTP server
	cloudprntHandler := NewCloudPRNTHandler(d.queue, "", d.logger)
	d.httpServer = &http.Server{
		Addr:    d.config.CloudPRNTListen,
		Handler: cloudprntHandler,
	}

	d.wg.Add(1)
	go func() {
		defer d.wg.Done()
		d.logger.Info().Str("addr", d.config.CloudPRNTListen).Msg("CloudPRNT server listening")
		if err := d.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			d.logger.Error().Err(err).Msg("CloudPRNT server error")
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
	d.logger.Info().Msg("Server ready")

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
		d.logger.Error().Err(err).Msg("Failed to read CLI request")
		return
	}

	// Parse request
	var req CLIRequest
	if err := json.Unmarshal(buf[:n], &req); err != nil {
		d.logger.Error().Err(err).Str("raw", string(buf[:n])).Msg("Failed to parse CLI request")
		resp := CLIResponse{Status: "error", Error: "invalid request"}
		json.NewEncoder(conn).Encode(resp)
		return
	}

	d.logger.Info().Str("command", req.Command).Msg("CLI command received")

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
		d.logger.Info().Str("job_id", job.ID).Str("content", content).Msg("Job added")
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
	d.logger.Info().Msg("Stopping server")
	close(d.stop)

	if d.httpServer != nil {
		d.httpServer.Close()
	}

	if d.cliListener != nil {
		d.cliListener.Close()
	}

	d.wg.Wait()
	d.logger.Info().Msg("Server stopped")
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
		Content:   content + "[feed:2]",
		Status:    JobStatusPending,
		CreatedAt: time.Now(),
	}
	d.queue.Add(job)
	d.logger.Info().Str("job_id", job.ID).Str("content", content).Msg("Job added to queue")
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
		d.logger.Info().Str("signal", sig.String()).Msg("Received signal")
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
