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

	"github.com/ChaseBro/receiptd/internal/db"
	"github.com/ChaseBro/receiptd/internal/shortid"
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
	db          *db.DB
	httpServer  *http.Server
	cliListener net.Listener
	ready       chan struct{}
	stop        chan struct{}
	stopOnce    sync.Once
	wg          sync.WaitGroup
	logger      zerolog.Logger
}

// NewDaemon creates a new daemon
func NewDaemon(cfg *Config) (*Daemon, error) {
	if cfg == nil {
		cfg = DefaultConfig()
	}

	// Ensure data directory exists before opening log/db
	if err := os.MkdirAll(cfg.DataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	// Setup logger
	logFile := filepath.Join(cfg.DataDir, "receiptd.log")
	f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	var logger zerolog.Logger
	if err != nil {
		logger = zerolog.New(os.Stderr).With().Timestamp().Str("module", "daemon").Logger()
	} else {
		logger = zerolog.New(f).With().Timestamp().Str("module", "daemon").Logger()
	}

	// Open database
	database, err := db.Open(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	d := &Daemon{
		config: cfg,
		queue:  NewQueue(),
		db:     database,
		ready:  make(chan struct{}),
		stop:   make(chan struct{}),
		logger: logger,
	}

	// Reload pending/in-flight jobs from DB into queue (crash recovery)
	if err := d.loadPendingJobs(); err != nil {
		database.Close()
		return nil, fmt.Errorf("load pending jobs: %w", err)
	}

	return d, nil
}

// loadPendingJobs reads pending/processing/acknowledged jobs from the DB and
// re-queues them as pending so they can be dispatched after a restart.
func (d *Daemon) loadPendingJobs() error {
	jobs, err := d.db.GetPendingJobs()
	if err != nil {
		return err
	}
	for _, dbJob := range jobs {
		// Reset in-flight states to pending so they get re-dispatched
		dbJob.Status = "pending"
		dbJob.StartedAt = nil
		dbJob.AcknowledgedAt = nil
		if err := d.db.UpdateJob(dbJob); err != nil {
			d.logger.Warn().Err(err).Str("job_id", dbJob.ID).Msg("Failed to reset job status in DB")
		}

		job := &Job{
			ID:        dbJob.ID,
			PrinterID: dbJob.PrinterID,
			Content:   dbJob.Content,
			ImagePath: dbJob.ImagePath,
			Status:    JobStatusPending,
			Staged:    dbJob.Staged,
			CreatedAt: dbJob.CreatedAt,
		}
		d.queue.Add(job)
		d.logger.Info().Str("job_id", job.ID).Msg("Recovered pending job from DB")
	}
	if len(jobs) > 0 {
		d.logger.Info().Int("count", len(jobs)).Msg("Recovered pending jobs from DB")
	}
	return nil
}

// Start starts the daemon
func (d *Daemon) Start() error {
	d.logger.Info().Msg("Starting receiptd server")
	d.logger.Info().Str("cloudprnt", d.config.CloudPRNTListen).Msg("CloudPRNT listen address")
	d.logger.Info().Str("cli", d.config.CLIListen).Msg("CLI listen address")

	// Start CloudPRNT HTTP server
	cloudprntHandler, err := NewCloudPRNTHandler(d, d.logger)
	if err != nil {
		return err
	}
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
				"running":     true,
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
		imagePath, _ := payload["imagePath"].(string)
		staged, _ := payload["staged"].(bool)

		job := d.AddJob(printerID, content, imagePath, staged)
		resp = CLIResponse{
			Status: "ok",
			Data:   job.ID,
		}
		d.logger.Info().Str("job_id", job.ID).Bool("staged", staged).Str("content", content).Str("image_path", imagePath).Msg("Job added")
	case "get_jobs":
		jobs := d.queue.GetAll()
		resp = CLIResponse{Status: "ok", Data: jobs}
	case "stop":
		resp = CLIResponse{Status: "ok"}
		json.NewEncoder(conn).Encode(resp)
		go d.Stop()
		return
	default:
		resp = CLIResponse{Status: "error", Error: "unknown command"}
	}

	json.NewEncoder(conn).Encode(resp)
}

// Stop stops the daemon gracefully. Safe to call multiple times.
func (d *Daemon) Stop() error {
	d.stopOnce.Do(func() {
		d.logger.Info().Msg("Stopping server")
		close(d.stop)

		if d.httpServer != nil {
			d.httpServer.Close()
		}

		if d.cliListener != nil {
			d.cliListener.Close()
		}

		d.wg.Wait()

		if d.db != nil {
			d.db.Close()
		}

		d.logger.Info().Msg("Server stopped")
	})
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

// AddJob adds a job to the queue and persists it to the DB.
// imagePath is an absolute local file path or a URL (file://, https://, data:).
// If staged is true the job is held and never dispatched to the printer.
func (d *Daemon) AddJob(printerID, content, imagePath string, staged bool) *Job {
	job := &Job{
		ID:        "job-" + shortid.New(time.Now()),
		PrinterID: printerID,
		Content:   content + "[feed:3][cut]",
		ImagePath: imagePath,
		Status:    JobStatusPending,
		Staged:    staged,
		CreatedAt: time.Now(),
	}
	d.queue.Add(job)

	dbJob := serverJobToDBJob(job)
	if err := d.db.SaveJob(dbJob); err != nil {
		d.logger.Error().Err(err).Str("job_id", job.ID).Msg("Failed to persist job to DB")
	}

	d.logger.Info().Str("job_id", job.ID).Bool("staged", staged).Str("content", content).Str("image_path", imagePath).Msg("Job added to queue")
	return job
}

// acknowledgeJob marks a job as acknowledged in the queue and updates the DB.
func (d *Daemon) acknowledgeJob(token string, success bool, errMsg string) bool {
	ok := d.queue.Acknowledge(token, success, errMsg)
	if !ok {
		return false
	}
	job := d.queue.Get(token)
	if job != nil {
		dbJob := serverJobToDBJob(job)
		if err := d.db.UpdateJob(dbJob); err != nil {
			d.logger.Error().Err(err).Str("job_id", token).Msg("Failed to update job in DB after acknowledge")
		}
	}
	return true
}

// takeNextJob atomically picks the next pending job, updates the DB, and returns it.
// printerID is written to the job record the first time it is dispatched.
func (d *Daemon) takeNextJob(printerID string) *Job {
	// Snapshot any jobs that were acknowledged before this call so we can
	// persist their completion after TakeNextJob transitions them.
	prevAcknowledged := d.queue.GetAll()
	acknowledgedIDs := make(map[string]bool)
	for _, j := range prevAcknowledged {
		if j.Status == JobStatusAcknowledged {
			acknowledgedIDs[j.ID] = true
		}
	}

	job := d.queue.TakeNextJob(printerID)

	// Persist any jobs that TakeNextJob finalized (acknowledged → completed)
	for _, j := range d.queue.GetAll() {
		if acknowledgedIDs[j.ID] && j.Status == JobStatusCompleted {
			dbJob := serverJobToDBJob(j)
			if err := d.db.UpdateJob(dbJob); err != nil {
				d.logger.Error().Err(err).Str("job_id", j.ID).Msg("Failed to update completed job in DB")
			}
		}
	}

	if job != nil {
		// Assign the printer ID now that we know which printer claimed this job
		job.PrinterID = printerID
		dbJob := serverJobToDBJob(job)
		if err := d.db.UpdateJob(dbJob); err != nil {
			d.logger.Error().Err(err).Str("job_id", job.ID).Msg("Failed to update dispatched job in DB")
		}
	}

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

// serverJobToDBJob converts a server.Job to a db.Job.
func serverJobToDBJob(j *Job) *db.Job {
	return &db.Job{
		ID:          j.ID,
		PrinterID:   j.PrinterID,
		Content:     j.Content,
		ImagePath:   j.ImagePath,
		Status:      j.Status,
		Staged:      j.Staged,
		ErrorMsg:    j.ErrorMsg,
		CreatedAt:   j.CreatedAt,
		StartedAt:   j.StartedAt,
		CompletedAt: j.CompletedAt,
	}
}
