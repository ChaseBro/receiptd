// Package services owns business logic that was previously split across the
// TCP and HTTP transport layers. Both transports (and eventually MCP) are thin
// adapters that validate input, call a service, and format the response — they
// must not contain any queue/DB/render logic of their own.
package services

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ChaseBro/receiptd/internal/db"
	"github.com/ChaseBro/receiptd/internal/imageproc"
	"github.com/ChaseBro/receiptd/internal/jobs"
	"github.com/ChaseBro/receiptd/internal/render"
	"github.com/ChaseBro/receiptd/internal/shortid"
	"github.com/rs/zerolog"
)

// CutSuffix is appended to every job's content so the printer feeds paper and
// cuts after each receipt. Callers must not include it themselves.
const CutSuffix = "[feed:3][cut]"

// Dispatcher is an optional hook called synchronously after a job is queued
// and persisted. Cloud-mode deployments use this to ship the rendered
// StarPRNT binary to the Cloudflare Worker that serves printer polls; local
// mode leaves it nil.
//
// A non-nil error from Dispatch surfaces to the caller of Jobs.Create. The
// job record is left in the queue/DB for future retry.
type Dispatcher interface {
	Dispatch(ctx context.Context, job *jobs.Job) error
}

// Jobs is the service that handles print-job lifecycle operations. It owns
// the input-resolution pipeline: HTML→PNG rendering, ImageData decoding,
// image-processing (dither/adjust), and markup assembly. The Dispatcher
// (if any) and the local CloudPRNT handler receive an already-resolved job
// with a Star Markup Content string and an on-disk ImagePath for any raster.
type Jobs struct {
	queue      *jobs.Queue
	db         *db.DB
	dispatcher Dispatcher
	dataDir    string // where resolved images are persisted
	logger     zerolog.Logger
}

// NewJobs builds a Jobs service. Pass a non-nil dispatcher to enable
// cloud-mode (ship each job to the worker on create). dataDir is where
// HTML-rendered and decoded images are persisted so the printer fetch path
// can find them later.
func NewJobs(queue *jobs.Queue, database *db.DB, dispatcher Dispatcher, dataDir string, logger zerolog.Logger) *Jobs {
	return &Jobs{
		queue:      queue,
		db:         database,
		dispatcher: dispatcher,
		dataDir:    dataDir,
		logger:     logger.With().Str("component", "services.jobs").Logger(),
	}
}

// CreateInput is the public shape of a new print job. Exactly one of Text,
// HTML, or ImageData must be set:
//
//   - Text     — plain text or Star Markup; passed straight to cputil
//   - HTML     — rendered server-side via chromedp to a 576px PNG
//   - ImageData — client-provided raster (PNG/JPEG bytes, already decoded
//     from any transport encoding by the caller)
//
// Caption is optional Star Markup prepended above an image; ignored for
// Text inputs. Dither/Brightness/Contrast/Gamma apply to HTML and
// ImageData only.
//
// The API deliberately does NOT expose filesystem paths — clients never
// name where images live on the server.
type CreateInput struct {
	PrinterID string
	Staged    bool

	Text      string
	HTML      string
	ImageData []byte
	Caption   string

	Dither     string  // e.g. "floyd-steinberg", "atkinson"; "" → no dither
	Brightness int     // -100..100
	Contrast   int     // -100..100
	Gamma      float64 // 0.5..2.5
}

// ErrEmptyJob is returned when a CreateInput has no input mode selected.
var ErrEmptyJob = errors.New("empty job: one of text, html, or imageData required")

// ErrAmbiguousInput is returned when more than one input mode is set.
var ErrAmbiguousInput = errors.New("ambiguous job: set exactly one of text, html, or imageData")

// Create resolves the job's inputs, enqueues it, persists it, and (in
// cloud mode) dispatches it to the worker.
func (s *Jobs) Create(ctx context.Context, in CreateInput) (*jobs.Job, error) {
	content, imagePath, err := s.resolveInputs(ctx, in)
	if err != nil {
		return nil, err
	}

	job := &jobs.Job{
		ID:        "job-" + shortid.New(time.Now()),
		PrinterID: in.PrinterID,
		Content:   content + CutSuffix,
		ImagePath: imagePath,
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
		Bool("has_image", imagePath != "").
		Msg("Job created")

	if s.dispatcher != nil && !in.Staged {
		if err := s.dispatcher.Dispatch(ctx, job); err != nil {
			s.logger.Error().Err(err).Str("job_id", job.ID).Msg("dispatch to worker failed")
			s.markFailed(job, fmt.Errorf("dispatch: %w", err))
			return job, fmt.Errorf("dispatch: %w", err)
		}
		s.markDispatched(job)
		s.logger.Info().Str("job_id", job.ID).Msg("Job dispatched to worker")
	}

	return job, nil
}

// markDispatched transitions a freshly-dispatched cloud job out of the
// "pending" state so recovery on next startup doesn't re-send it. Fly
// relinquishes state ownership once the worker has the binary — without
// this flip, scale-to-zero bounces would replay the entire lifetime of
// cloud prints on every restart.
func (s *Jobs) markDispatched(job *jobs.Job) {
	job.Status = jobs.JobStatusDispatched
	if err := s.db.UpdateJob(jobToDB(job)); err != nil {
		s.logger.Error().Err(err).Str("job_id", job.ID).Msg("persist dispatched status")
	}
}

// Redispatch re-runs the dispatcher for a previously persisted job. Used
// during daemon startup recovery — a job whose dispatch was interrupted
// (crash, scale-to-zero bounce, or initial failure) is re-queued from the
// DB, then pushed to the worker again. If dispatch still fails, the job
// is marked "failed" so it doesn't accumulate as a ghost pending entry.
//
// Only truly "pending" jobs should reach this path — jobs that made it
// to "dispatched" were already handed to the worker and must not be
// re-sent on restart (that caused the 2026-04-20 replay storm). Callers
// are responsible for filtering.
func (s *Jobs) Redispatch(ctx context.Context, job *jobs.Job) error {
	if s.dispatcher == nil || job == nil || job.Staged {
		return nil
	}
	if err := s.dispatcher.Dispatch(ctx, job); err != nil {
		s.logger.Error().Err(err).Str("job_id", job.ID).Msg("re-dispatch failed")
		s.markFailed(job, fmt.Errorf("dispatch: %w", err))
		return err
	}
	s.markDispatched(job)
	s.logger.Info().Str("job_id", job.ID).Msg("Job re-dispatched on recovery")
	return nil
}

// markFailed transitions a pending job to Failed status, records the
// error, and persists to DB. Failures in persistence are logged but not
// re-returned — the caller already has the primary error to surface.
func (s *Jobs) markFailed(job *jobs.Job, cause error) {
	job.Status = jobs.JobStatusFailed
	job.ErrorMsg = cause.Error()
	now := time.Now()
	job.CompletedAt = &now
	if err := s.db.UpdateJob(jobToDB(job)); err != nil {
		s.logger.Error().Err(err).Str("job_id", job.ID).Msg("persist failed status")
	}
}

// resolveInputs turns the public CreateInput shape into the internal
// (content, imagePath) pair the queue + CloudPRNT handler expect.
//
//   - Text   → content=text, imagePath=""
//   - HTML   → render PNG to dataDir, run imageproc, imagePath=<path>, content=caption
//   - Image  → write bytes to dataDir, run imageproc, imagePath=<path>, content=caption
func (s *Jobs) resolveInputs(ctx context.Context, in CreateInput) (content, imagePath string, err error) {
	modes := 0
	if in.Text != "" {
		modes++
	}
	if in.HTML != "" {
		modes++
	}
	if len(in.ImageData) > 0 {
		modes++
	}
	if modes == 0 {
		return "", "", ErrEmptyJob
	}
	if modes > 1 {
		return "", "", ErrAmbiguousInput
	}

	if in.Text != "" {
		return in.Text, "", nil
	}

	// HTML or ImageData: produce a PNG on disk, then apply imageproc if
	// any dither/adjust flags were set.
	var raw []byte
	switch {
	case in.HTML != "":
		raw, err = render.HTMLToPNG(in.HTML, 0)
		if err != nil {
			return "", "", fmt.Errorf("render html: %w", err)
		}
	default:
		raw = in.ImageData
	}

	processed, err := imageproc.Process(raw, imageprocOptsFrom(in))
	if err != nil {
		return "", "", fmt.Errorf("image processing: %w", err)
	}

	path, err := render.SaveRender(s.dataDir, processed)
	if err != nil {
		return "", "", fmt.Errorf("persist image: %w", err)
	}
	return in.Caption, path, nil
}

func imageprocOptsFrom(in CreateInput) imageproc.Options {
	alg := imageproc.Algorithm(in.Dither)
	if alg == "" {
		alg = imageproc.None
	}
	return imageproc.Options{
		Algorithm:  alg,
		Brightness: in.Brightness,
		Contrast:   in.Contrast,
		Gamma:      in.Gamma,
	}
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
