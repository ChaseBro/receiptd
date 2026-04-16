// Package services owns business logic that was previously split across the
// TCP and HTTP transport layers. Both transports (and eventually MCP) are thin
// adapters that validate input, call a service, and format the response — they
// must not contain any queue/DB/render logic of their own.
package services

import (
	"context"
	"errors"
	"time"

	"github.com/ChaseBro/receiptd/internal/db"
	"github.com/ChaseBro/receiptd/internal/jobs"
	"github.com/ChaseBro/receiptd/internal/shortid"
	"github.com/rs/zerolog"
)

// CutSuffix is appended to every job's content so the printer feeds paper and
// cuts after each receipt. Callers must not include it themselves.
const CutSuffix = "[feed:3][cut]"

// Jobs is the service that handles print-job lifecycle operations.
type Jobs struct {
	queue  *jobs.Queue
	db     *db.DB
	logger zerolog.Logger
}

// NewJobs builds a Jobs service.
func NewJobs(queue *jobs.Queue, database *db.DB, logger zerolog.Logger) *Jobs {
	return &Jobs{
		queue:  queue,
		db:     database,
		logger: logger.With().Str("component", "services.jobs").Logger(),
	}
}

// CreateInput describes a new print job. Either Content or ImagePath must be
// non-empty; both may be set if the image should have caption markup.
type CreateInput struct {
	PrinterID string
	Content   string
	ImagePath string
	Staged    bool
}

// ErrEmptyJob is returned when a CreateInput has neither content nor image.
var ErrEmptyJob = errors.New("empty job: content or imagePath required")

// Create enqueues a new job, appending the CutSuffix and persisting to the DB.
// Returns the queued job.
func (s *Jobs) Create(ctx context.Context, in CreateInput) (*jobs.Job, error) {
	if in.Content == "" && in.ImagePath == "" {
		return nil, ErrEmptyJob
	}
	job := &jobs.Job{
		ID:        "job-" + shortid.New(time.Now()),
		PrinterID: in.PrinterID,
		Content:   in.Content + CutSuffix,
		ImagePath: in.ImagePath,
		Status:    jobs.JobStatusPending,
		Staged:    in.Staged,
		CreatedAt: time.Now(),
	}
	s.queue.Add(job)

	if err := s.db.SaveJob(jobToDB(job)); err != nil {
		// DB persistence failure is logged but non-fatal — the in-memory queue
		// has the job and the printer will still pick it up. Future: make this
		// a hard failure once the DB is on durable storage in cloud mode.
		s.logger.Error().Err(err).Str("job_id", job.ID).Msg("persist job")
	}

	s.logger.Info().
		Str("job_id", job.ID).
		Bool("staged", in.Staged).
		Str("printer_id", in.PrinterID).
		Msg("Job created")
	return job, nil
}

// Get returns the in-memory queue entry for a job ID. Returns nil if the job
// has been evicted from memory (current queue never evicts, but a future
// compaction may).
func (s *Jobs) Get(ctx context.Context, id string) *jobs.Job {
	return s.queue.Get(id)
}

// List returns all jobs currently in the in-memory queue.
func (s *Jobs) List(ctx context.Context) []*jobs.Job {
	return s.queue.GetAll()
}

// jobToDB converts the in-memory queue representation to the persistence
// representation. Kept in services because it spans both packages.
func jobToDB(j *jobs.Job) *db.Job {
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
