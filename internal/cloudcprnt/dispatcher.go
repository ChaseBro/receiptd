package cloudcprnt

import (
	"context"
	"fmt"

	"github.com/ChaseBro/receiptd/internal/cputil"
	"github.com/ChaseBro/receiptd/internal/jobs"
)

// Dispatcher implements services.Dispatcher by rendering a job's markup
// through cputil and POSTing the resulting StarPRNT binary to the worker.
// It satisfies the services.Dispatcher interface without an explicit
// declaration so services has no import dependency on this package.
type Dispatcher struct {
	client     *Client
	cputilPath string
}

// NewDispatcher wires a cloud-mode dispatcher. Both args must be non-nil/
// non-empty for dispatch to work; if client is nil, NewDispatcher returns
// nil (the caller should skip wiring the dispatcher entirely).
func NewDispatcher(client *Client, cputilPath string) *Dispatcher {
	if client == nil || cputilPath == "" {
		return nil
	}
	return &Dispatcher{client: client, cputilPath: cputilPath}
}

// Dispatch renders job content (plus optional image tag) into a StarPRNT
// binary and POSTs it to the worker's /admin/jobs. Called by
// services.Jobs.Create when the daemon is in cloud-mode.
func (d *Dispatcher) Dispatch(ctx context.Context, job *jobs.Job) error {
	if job == nil {
		return fmt.Errorf("cloudcprnt dispatcher: nil job")
	}
	markup := cputil.BuildMarkup(job.Content, job.ImagePath)
	binary, err := cputil.Convert(d.cputilPath, markup)
	if err != nil {
		return fmt.Errorf("cputil convert: %w", err)
	}
	return d.client.PostJob(ctx, job.PrinterID, job.ID, binary, cputil.MediaTypeStarPRNT)
}
