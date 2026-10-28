package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"

	"github.com/ChaseBro/receiptd/internal/jobs"
	"github.com/ChaseBro/receiptd/internal/services"
	"github.com/rs/zerolog"
)

// recordingDispatcher captures the printer each job was dispatched to and
// optionally fails, standing in for the cloud worker client.
type recordingDispatcher struct {
	printerIDs []string
	err        error
}

func (r *recordingDispatcher) Dispatch(ctx context.Context, job *jobs.Job) error {
	r.printerIDs = append(r.printerIDs, job.PrinterID)
	return r.err
}

func newCloudTestDaemon(t *testing.T, disp services.Dispatcher, defaultPrinter string) *Daemon {
	t.Helper()
	d := newTestDaemon(t)
	d.config.DefaultPrinterID = defaultPrinter
	d.jobs = services.NewJobs(d.queue, d.db, disp, d.config.DataDir, zerolog.Nop())
	return d
}

// sendCLI runs one request through handleCLIConn over an in-memory pipe.
func sendCLI(t *testing.T, d *Daemon, req CLIRequest) CLIResponse {
	t.Helper()
	client, srv := net.Pipe()
	defer client.Close()
	d.wg.Add(1)
	go d.handleCLIConn(srv)

	if err := json.NewEncoder(client).Encode(req); err != nil {
		t.Fatalf("write request: %v", err)
	}
	var resp CLIResponse
	if err := json.NewDecoder(client).Decode(&resp); err != nil {
		t.Fatalf("read response: %v", err)
	}
	return resp
}

func TestCLIAddJob_FallsBackToDefaultPrinter(t *testing.T) {
	disp := &recordingDispatcher{}
	d := newCloudTestDaemon(t, disp, "default-printer")

	resp := sendCLI(t, d, CLIRequest{Command: "add_job", Payload: map[string]interface{}{"content": "hello"}})
	if resp.Status != "ok" {
		t.Fatalf("want ok, got %+v", resp)
	}
	if len(disp.printerIDs) != 1 || disp.printerIDs[0] != "default-printer" {
		t.Fatalf("want dispatch to default-printer, got %v", disp.printerIDs)
	}
}

func TestCLIAddJob_DispatchErrorIsReportedNotPanic(t *testing.T) {
	disp := &recordingDispatcher{err: errors.New("worker unreachable")}
	d := newCloudTestDaemon(t, disp, "default-printer")

	resp := sendCLI(t, d, CLIRequest{Command: "add_job", Payload: map[string]interface{}{"content": "hello"}})
	if resp.Status != "error" || resp.Error == "" {
		t.Fatalf("want error response, got %+v", resp)
	}
}

func TestCLIAddJob_UnreadableImageIsReported(t *testing.T) {
	d := newCloudTestDaemon(t, &recordingDispatcher{}, "default-printer")

	resp := sendCLI(t, d, CLIRequest{Command: "add_job", Payload: map[string]interface{}{
		"content":   "caption",
		"imagePath": "/nonexistent/photo.png",
	}})
	if resp.Status != "error" {
		t.Fatalf("want error response, got %+v", resp)
	}
}
