package db

import (
	"database/sql"
	"fmt"
	"time"
)

// Job mirrors server.Job for DB persistence (avoids circular imports).
type Job struct {
	ID             string
	PrinterID      string
	Content        string
	Status         string
	Staged         bool
	ErrorMsg       string
	CreatedAt      time.Time
	StartedAt      *time.Time
	CompletedAt    *time.Time
	AcknowledgedAt *time.Time
}

// SaveJob inserts a new job (INSERT OR REPLACE).
func (d *DB) SaveJob(j *Job) error {
	_, err := d.Exec(`
		INSERT OR REPLACE INTO jobs
		    (id, printer_id, content, status, staged, error_msg,
		     created_at, started_at, completed_at, acknowledged_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		j.ID,
		nullString(j.PrinterID),
		j.Content,
		j.Status,
		boolToInt(j.Staged),
		nullString(j.ErrorMsg),
		j.CreatedAt.UTC().Format(time.RFC3339Nano),
		nullTime(j.StartedAt),
		nullTime(j.CompletedAt),
		nullTime(j.AcknowledgedAt),
	)
	if err != nil {
		return fmt.Errorf("save job %s: %w", j.ID, err)
	}
	return nil
}

// UpdateJob updates all mutable fields of an existing job.
func (d *DB) UpdateJob(j *Job) error {
	_, err := d.Exec(`
		UPDATE jobs SET
		    printer_id      = ?,
		    status          = ?,
		    error_msg       = ?,
		    started_at      = ?,
		    completed_at    = ?,
		    acknowledged_at = ?
		WHERE id = ?`,
		nullString(j.PrinterID),
		j.Status,
		nullString(j.ErrorMsg),
		nullTime(j.StartedAt),
		nullTime(j.CompletedAt),
		nullTime(j.AcknowledgedAt),
		j.ID,
	)
	if err != nil {
		return fmt.Errorf("update job %s: %w", j.ID, err)
	}
	return nil
}

// GetJob retrieves a single job by ID.
func (d *DB) GetJob(id string) (*Job, error) {
	row := d.QueryRow(`SELECT id, printer_id, content, status, staged, error_msg,
	    created_at, started_at, completed_at, acknowledged_at FROM jobs WHERE id = ?`, id)
	j, err := scanJob(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return j, err
}

// GetPendingJobs returns jobs that were pending or processing at shutdown (for crash recovery).
// All are reset to 'pending' so they can be re-dispatched.
func (d *DB) GetPendingJobs() ([]*Job, error) {
	rows, err := d.Query(`
		SELECT id, printer_id, content, status, staged, error_msg,
		       created_at, started_at, completed_at, acknowledged_at
		FROM jobs
		WHERE status IN ('pending', 'processing', 'acknowledged')
		ORDER BY created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("get pending jobs: %w", err)
	}
	defer rows.Close()
	return scanJobs(rows)
}

// GetAllJobs returns all jobs ordered by creation time descending.
func (d *DB) GetAllJobs() ([]*Job, error) {
	rows, err := d.Query(`
		SELECT id, printer_id, content, status, staged, error_msg,
		       created_at, started_at, completed_at, acknowledged_at
		FROM jobs
		ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("get all jobs: %w", err)
	}
	defer rows.Close()
	return scanJobs(rows)
}

// PruneOldJobs deletes completed/failed jobs older than the given duration.
func (d *DB) PruneOldJobs(olderThan time.Duration) error {
	cutoff := time.Now().Add(-olderThan).UTC().Format(time.RFC3339Nano)
	_, err := d.Exec(`DELETE FROM jobs WHERE status IN ('completed','failed') AND created_at < ?`, cutoff)
	return err
}

// --- scan helpers ---

type rowScanner interface {
	Scan(dest ...any) error
}

func scanJob(row rowScanner) (*Job, error) {
	var j Job
	var printerID, errorMsg, startedAt, completedAt, acknowledgedAt sql.NullString
	var staged int

	err := row.Scan(
		&j.ID, &printerID, &j.Content, &j.Status, &staged, &errorMsg,
		&j.CreatedAt, &startedAt, &completedAt, &acknowledgedAt,
	)
	if err != nil {
		return nil, err
	}
	j.PrinterID = printerID.String
	j.ErrorMsg = errorMsg.String
	j.Staged = staged != 0
	j.StartedAt = parseNullTime(startedAt)
	j.CompletedAt = parseNullTime(completedAt)
	j.AcknowledgedAt = parseNullTime(acknowledgedAt)
	return &j, nil
}

func scanJobs(rows *sql.Rows) ([]*Job, error) {
	var jobs []*Job
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

// --- null helpers ---

func nullString(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}

func nullTime(t *time.Time) sql.NullString {
	if t == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: t.UTC().Format(time.RFC3339Nano), Valid: true}
}

func parseNullTime(s sql.NullString) *time.Time {
	if !s.Valid || s.String == "" {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, s.String)
	if err != nil {
		return nil
	}
	return &t
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
