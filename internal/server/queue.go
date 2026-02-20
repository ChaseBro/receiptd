package server

import (
	"sync"
	"time"
)

// Job represents a print job in the queue
type Job struct {
	ID        string    `json:"id"`
	PrinterID string    `json:"printerId"`
	Content   string    `json:"content"`
	Status    string    `json:"status"` // pending, processing, completed, failed
	CreatedAt time.Time `json:"createdAt"`
	StartedAt *time.Time `json:"startedAt,omitempty"`
	CompletedAt *time.Time `json:"completedAt,omitempty"`
	ErrorMsg  string    `json:"errorMsg,omitempty"`
}

// Job status constants
const (
	JobStatusPending    = "pending"
	JobStatusProcessing = "processing"
	JobStatusCompleted  = "completed"
	JobStatusFailed     = "failed"
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

// StartProcessing marks a job as processing
func (q *Queue) StartProcessing(token string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	
	job, ok := q.jobs[token]
	if !ok {
		return false
	}
	
	now := time.Now()
	job.Status = JobStatusProcessing
	job.StartedAt = &now
	return true
}

// Complete marks a job as completed
func (q *Queue) Complete(token string, success bool, errMsg string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	
	job, ok := q.jobs[token]
	if !ok {
		return false
	}
	
	now := time.Now()
	if success {
		job.Status = JobStatusCompleted
	} else {
		job.Status = JobStatusFailed
		job.ErrorMsg = errMsg
	}
	job.CompletedAt = &now
	return true
}