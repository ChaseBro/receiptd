package services

import (
	"context"
	"errors"
	"testing"

	"github.com/ChaseBro/receiptd/internal/jobs"
	"github.com/rs/zerolog"
)

type fakeDispatcher struct {
	called bool
	job    *jobs.Job
	err    error
}

func (f *fakeDispatcher) Dispatch(ctx context.Context, j *jobs.Job) error {
	f.called = true
	f.job = j
	return f.err
}

func TestJobs_Create_NoDispatcherSkipsWorker(t *testing.T) {
	s := NewJobs(jobs.NewQueue(), newTestDB(t), nil, t.TempDir(), zerolog.Nop())
	job, err := s.Create(context.Background(), CreateInput{Text: "hi"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if job == nil || job.Content != "hi"+CutSuffix {
		t.Fatalf("unexpected job: %+v", job)
	}
}

func TestJobs_Create_DispatchesWhenConfigured(t *testing.T) {
	d := &fakeDispatcher{}
	s := NewJobs(jobs.NewQueue(), newTestDB(t), d, t.TempDir(), zerolog.Nop())

	job, err := s.Create(context.Background(), CreateInput{PrinterID: "p1", Text: "hi"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !d.called {
		t.Fatal("dispatcher was not invoked")
	}
	if d.job == nil || d.job.ID != job.ID || d.job.PrinterID != "p1" {
		t.Fatalf("dispatcher received wrong job: %+v", d.job)
	}
	// After successful Dispatch, status must leave "pending" so recovery
	// on next startup doesn't replay the handoff — the replay-storm fix.
	if job.Status != jobs.JobStatusDispatched {
		t.Fatalf("status after successful Dispatch = %q, want dispatched (prevents replay on restart)", job.Status)
	}
}

func TestJobs_Create_StagedSkipsDispatch(t *testing.T) {
	d := &fakeDispatcher{}
	s := NewJobs(jobs.NewQueue(), newTestDB(t), d, t.TempDir(), zerolog.Nop())

	_, err := s.Create(context.Background(), CreateInput{Text: "hi", Staged: true})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if d.called {
		t.Fatal("staged job must not dispatch")
	}
}

func TestJobs_Create_SurfacesDispatchError(t *testing.T) {
	d := &fakeDispatcher{err: errors.New("worker down")}
	s := NewJobs(jobs.NewQueue(), newTestDB(t), d, t.TempDir(), zerolog.Nop())

	job, err := s.Create(context.Background(), CreateInput{Text: "hi"})
	if err == nil {
		t.Fatal("expected error when dispatcher fails")
	}
	// Job should still be returned so callers can see the queued record.
	if job == nil {
		t.Fatal("job record must be returned even on dispatch error")
	}
	// Ghost-job guard: failed dispatch must flip job to Failed so callers
	// see a terminal state rather than a pending entry that never moves.
	if job.Status != jobs.JobStatusFailed {
		t.Fatalf("dispatch-failed job status = %q, want %q", job.Status, jobs.JobStatusFailed)
	}
	if job.ErrorMsg == "" {
		t.Fatal("ErrorMsg should be populated on dispatch failure")
	}
}

func TestJobs_Redispatch_OnSuccess(t *testing.T) {
	d := &fakeDispatcher{}
	s := NewJobs(jobs.NewQueue(), newTestDB(t), d, t.TempDir(), zerolog.Nop())

	recovered := &jobs.Job{ID: "job-rx1", PrinterID: "p", Status: jobs.JobStatusPending}
	if err := s.Redispatch(context.Background(), recovered); err != nil {
		t.Fatalf("Redispatch: %v", err)
	}
	if !d.called {
		t.Fatal("dispatcher should be invoked on recovery")
	}
	if recovered.Status != jobs.JobStatusDispatched {
		t.Fatalf("status after successful re-dispatch = %q, want dispatched", recovered.Status)
	}
}

func TestJobs_Redispatch_OnFailure_MarksFailed(t *testing.T) {
	d := &fakeDispatcher{err: errors.New("still down")}
	s := NewJobs(jobs.NewQueue(), newTestDB(t), d, t.TempDir(), zerolog.Nop())

	recovered := &jobs.Job{ID: "job-rx2", PrinterID: "p", Status: jobs.JobStatusPending}
	if err := s.Redispatch(context.Background(), recovered); err == nil {
		t.Fatal("expected error on persistent worker failure")
	}
	if recovered.Status != jobs.JobStatusFailed {
		t.Fatalf("status after failed re-dispatch = %q, want failed", recovered.Status)
	}
}

func TestJobs_Redispatch_StagedSkipsDispatch(t *testing.T) {
	d := &fakeDispatcher{}
	s := NewJobs(jobs.NewQueue(), newTestDB(t), d, t.TempDir(), zerolog.Nop())

	recovered := &jobs.Job{ID: "job-rx3", Status: jobs.JobStatusPending, Staged: true}
	if err := s.Redispatch(context.Background(), recovered); err != nil {
		t.Fatalf("Redispatch: %v", err)
	}
	if d.called {
		t.Fatal("staged jobs must not be re-dispatched")
	}
}

func TestJobs_Redispatch_NilDispatcherNoOp(t *testing.T) {
	s := NewJobs(jobs.NewQueue(), newTestDB(t), nil, t.TempDir(), zerolog.Nop())
	if err := s.Redispatch(context.Background(), &jobs.Job{ID: "j", Status: jobs.JobStatusPending}); err != nil {
		t.Fatalf("no-op should succeed: %v", err)
	}
}
