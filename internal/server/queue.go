package server

import (
	"sync"
	"time"
)

// Job represents a print job in the queue
type Job struct {
	ID          string     `json:"id"`
	PrinterID   string     `json:"printerId"`
	Content     string     `json:"content"`
	Status      string     `json:"status"` // pending, processing, completed, failed
	Staged      bool       `json:"staged,omitempty"` // held in queue, never dispatched to printer
	CreatedAt   time.Time  `json:"createdAt"`
	StartedAt   *time.Time `json:"startedAt,omitempty"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
	ErrorMsg    string     `json:"errorMsg,omitempty"`
}

// Job status constants
const (
	JobStatusPending      = "pending"
	JobStatusProcessing   = "processing"
	JobStatusAcknowledged = "acknowledged" // DELETE received; waiting for next poll before issuing next job
	JobStatusCompleted    = "completed"
	JobStatusFailed       = "failed"
)

// Queue manages print jobs
type Queue struct {
	jobs map[string]*Job // token -> job
	mu   sync.RWMutex
}

// NewQueue creates a new job queue
func NewQueue() *Queue {
	return &Queue{
		jobs: make(map[string]*Job),
	}
}

// Add adds a new job to the queue
func (q *Queue) Add(job *Job) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.jobs[job.ID] = job
}

// Get retrieves a job by token
func (q *Queue) Get(token string) *Job {
	q.mu.RLock()
	defer q.mu.RUnlock()
	return q.jobs[token]
}

// GetPendingForPrinter returns the oldest pending job for a printer
func (q *Queue) GetPendingForPrinter(printerID string) *Job {
	q.mu.RLock()
	defer q.mu.RUnlock()

	var oldest *Job
	for _, job := range q.jobs {
		if job.Status == JobStatusPending && (printerID == "" || job.PrinterID == printerID) {
			if oldest == nil || job.CreatedAt.Before(oldest.CreatedAt) {
				oldest = job
			}
		}
	}
	return oldest
}

// TakeNextJob atomically finds the next pending job and marks it processing.
// Returns nil if the printer is busy or no jobs are pending.
//
// "Acknowledged" jobs (DELETE received) are finalized to "completed" on this poll,
// but we still return nil — the printer fired DELETE immediately after GET as a
// data-receipt ack and is still physically printing. The poll *after* that is when
// it's truly idle and ready for the next job.
func (q *Queue) TakeNextJob(printerID string) *Job {
	q.mu.Lock()
	defer q.mu.Unlock()

	now := time.Now()

	// Finalize any acknowledged jobs (DELETE received).
	// Don't return nil here — the printer sends a rapid poll right after DELETE,
	// which is exactly when it's ready for the next job.
	for _, job := range q.jobs {
		if job.Status == JobStatusAcknowledged {
			job.Status = JobStatusCompleted
			job.CompletedAt = &now
		}
	}

	// Block only if a job is still processing (post-GET rapid poll — printer is
	// still printing and will ignore any new token we hand out).
	for _, job := range q.jobs {
		if job.Status == JobStatusProcessing {
			return nil
		}
	}

	var oldest *Job
	for _, job := range q.jobs {
		if job.Status == JobStatusPending && !job.Staged && (printerID == "" || job.PrinterID == printerID) {
			if oldest == nil || job.CreatedAt.Before(oldest.CreatedAt) {
				oldest = job
			}
		}
	}
	if oldest == nil {
		return nil
	}

	oldest.Status = JobStatusProcessing
	oldest.StartedAt = &now
	return oldest
}

// GetAll returns all jobs
func (q *Queue) GetAll() []*Job {
	q.mu.RLock()
	defer q.mu.RUnlock()
	
	jobs := make([]*Job, 0, len(q.jobs))
	for _, job := range q.jobs {
		jobs = append(jobs, job)
	}
	return jobs
}

// StartProcessing atomically transitions a job from pending → processing.
// Returns false if the job doesn't exist or is not in pending state (guards against concurrent polls).
func (q *Queue) StartProcessing(token string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	job, ok := q.jobs[token]
	if !ok || job.Status != JobStatusPending {
		return false
	}

	now := time.Now()
	job.Status = JobStatusProcessing
	job.StartedAt = &now
	return true
}

// Acknowledge marks a job as acknowledged (DELETE received from printer).
// The job moves to "completed" on the next poll, acting as a one-poll buffer
// so we don't issue a new job while the printer is still physically printing.
func (q *Queue) Acknowledge(token string, success bool, errMsg string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	job, ok := q.jobs[token]
	if !ok {
		return false
	}

	if success {
		job.Status = JobStatusAcknowledged
	} else {
		// On failure, go straight to failed — no point buffering
		now := time.Now()
		job.Status = JobStatusFailed
		job.ErrorMsg = errMsg
		job.CompletedAt = &now
	}
	return true
}
// GetPendingCount returns the number of pending jobs
func (q *Queue) GetPendingCount() int {
	q.mu.RLock()
	defer q.mu.RUnlock()

	count := 0
	for _, job := range q.jobs {
		if job.Status == JobStatusPending {
			count++
		}
	}
	return count
}

// CountByStatus returns counts of pending and in-flight (processing+acknowledged) jobs.
func (q *Queue) CountByStatus() (pending, processing int) {
	q.mu.RLock()
	defer q.mu.RUnlock()

	for _, job := range q.jobs {
		switch job.Status {
		case JobStatusPending:
			pending++
		case JobStatusProcessing, JobStatusAcknowledged:
			processing++
		}
	}
	return
}

// GetStaleProcessing returns processing jobs whose StartedAt is older than maxAge.
func (q *Queue) GetStaleProcessing(maxAge time.Duration) []*Job {
	q.mu.RLock()
	defer q.mu.RUnlock()

	var stale []*Job
	for _, job := range q.jobs {
		if job.Status == JobStatusProcessing && job.StartedAt != nil {
			if time.Since(*job.StartedAt) > maxAge {
				stale = append(stale, job)
			}
		}
	}
	return stale
}

// ResetToPending resets a processing job back to pending so it can be retried.
func (q *Queue) ResetToPending(token string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	job, ok := q.jobs[token]
	if !ok || job.Status != JobStatusProcessing {
		return false
	}
	job.Status = JobStatusPending
	job.StartedAt = nil
	return true
}
