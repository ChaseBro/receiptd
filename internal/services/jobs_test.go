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
}
