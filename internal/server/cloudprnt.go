package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"
)

type CloudPRNTHandler struct {
	queue       *Queue
	printer     string
	logger      zerolog.Logger
	cputilPath  string
	mediaTypes  []string
}

func NewCloudPRNTHandler(queue *Queue, printerID string, logger zerolog.Logger) *CloudPRNTHandler {
	return &CloudPRNTHandler{
		queue:      queue,
		printer:    printerID,
		logger:     logger,
		cputilPath: "/Users/chase/.openclaw/workspace/projects/print-booth/cloudprnt-sdk/cputil-bin/cputil",
		mediaTypes: []string{"text/vnd.star.markup", "text/plain"},
	}
}

func (h *CloudPRNTHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.logger.Info().Str("method", r.Method).Str("url", r.URL.Path).Str("remote", r.RemoteAddr).Msg("CloudPRNT request")
	
	switch r.Method {
	case http.MethodPost:
		h.handlePoll(w, r)
	case http.MethodGet:
		h.handleGetJob(w, r)
	case http.MethodDelete:
		h.handleComplete(w, r)
	default:
		h.logger.Warn().Str("method", r.Method).Msg("Method not allowed")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *CloudPRNTHandler) convertToStarPRNT(markup string) ([]byte, error) {
	tmpFile, err := os.CreateTemp("", "markup-*.stm")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmpFile.Name())

	tmpFile.WriteString(markup)
	tmpFile.Close()

	cmd := exec.Command(
		h.cputilPath,
		"thermal3",
		"decode",
		"application/vnd.star.starprnt",
		tmpFile.Name(),
		"-",
	)
	output, err := cmd.Output()
	if err != nil {
		h.logger.Error().Err(err).Msg("cputil failed")
		return nil, err
	}
	
	return output, nil
}

type CloudPRNTPollResponse struct {
	JobReady     bool     `json:"jobReady"`
	MediaTypes   []string `json:"mediaTypes"`
	JobToken     string   `json:"jobToken,omitempty"`
	PollInterval int      `json:"pollInterval"`
	DeleteMethod string   `json:"deleteMethod"`
}

func (h *CloudPRNTHandler) handlePoll(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)

	var bodyMap map[string]interface{}
	if len(body) > 0 {
		json.Unmarshal(body, &bodyMap)
	}

	mac := ""
	if m, ok := bodyMap["printerMAC"].(string); ok {
		mac = m
	}
	if mac == "" {
		mac = r.Header.Get("X-Star-Mac")
	}

	// Log the full poll body so we can see printer status fields
	h.logger.Info().Str("mac", mac).RawJSON("body", body).Msg("Printer poll")

	// Log queue state on every poll for debugging
	pending, processing := h.queue.CountByStatus()
	h.logger.Debug().Int("pending", pending).Int("processing", processing).Msg("Queue state")

	// Warn about stale processing jobs (stuck > 30s means printer never DELETEd)
	stale := h.queue.GetStaleProcessing(30 * time.Second)
	for _, sj := range stale {
		h.logger.Warn().Str("job_id", sj.ID).Dur("age", time.Since(*sj.StartedAt)).Msg("Stale processing job — printer may have missed it; resetting to pending")
		h.queue.ResetToPending(sj.ID)
	}

	// Atomically check for in-flight jobs, find next pending, and mark it processing.
	// This prevents the TOCTOU race where two concurrent polls both see processing=0
	// and each grabs a different pending job.
	job := h.queue.TakeNextJob(h.printer)

	if job == nil {
		h.logger.Debug().Int("pending", pending).Int("processing", processing).Msg("No job available (busy or empty)")
		// If jobs are waiting but we're holding off (in-flight/acknowledged), poll back quickly.
		// Otherwise use the normal 5s idle interval.
		pollInterval := 5
		if pending > 0 {
			pollInterval = 1
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(CloudPRNTPollResponse{
			JobReady:     false,
			MediaTypes:   h.mediaTypes,
			PollInterval: pollInterval,
			DeleteMethod: "DELETE",
		})
		return
	}

	token := job.ID

	h.logger.Info().Str("job_id", job.ID).Str("token", token).Msg("Job ready — returning to printer")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(CloudPRNTPollResponse{
		JobReady:     true,
		MediaTypes:   h.mediaTypes,
		JobToken:     token,
		PollInterval: 5,
		DeleteMethod: "DELETE",
	})
}

func (h *CloudPRNTHandler) handleGetJob(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	mediaType := r.URL.Query().Get("type")
	
	// Check Accept header for preference
	acceptHeader := r.Header.Get("Accept")
	h.logger.Info().Str("token", token).Str("type", mediaType).Str("accept", acceptHeader).Msg("GET job")
	
	job := h.queue.Get(token)
	if job == nil {
		h.logger.Warn().Str("token", token).Msg("Job not found")
		http.Error(w, "Job not found", http.StatusNotFound)
		return
	}
	
	// Default to starprnt if no type specified
	if mediaType == "" {
		mediaType = "application/vnd.star.starprnt"
	}
	
	h.logger.Info().Str("job_id", job.ID).Str("mediaType", mediaType).Msg("Serving job")
	
	binary, err := h.convertToStarPRNT(job.Content)
	if err != nil {
		h.logger.Error().Err(err).Msg("cputil failed")
		http.Error(w, fmt.Sprintf("cputil conversion failed: %v", err), http.StatusInternalServerError)
		return
	}

	h.logger.Info().Int("binary_size", len(binary)).Msg("Serving starprnt binary")
	w.Header().Set("Content-Type", "application/vnd.star.starprnt")
	w.Write(binary)
}

func (h *CloudPRNTHandler) handleComplete(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	code := r.URL.Query().Get("code")
	success := code == "0" || code == "" || strings.Contains(code, "200")

	// Log all query params so we can see exactly what the printer sends
	h.logger.Info().Str("token", token).Bool("success", success).Str("code", code).Str("raw_query", r.URL.RawQuery).Msg("Job complete (DELETE)")

	ok := h.queue.Acknowledge(token, success, "")
	if !ok {
		h.logger.Warn().Str("token", token).Msg("DELETE for unknown token — job may have already been removed")
	}

	w.WriteHeader(http.StatusNoContent)
}

type PrinterRegistry struct {
	printers map[string]interface{}
	mu       sync.RWMutex
}

func NewPrinterRegistry() *PrinterRegistry {
	return &PrinterRegistry{printers: make(map[string]interface{})}
}

func (r *PrinterRegistry) Get(mac string) interface{} {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.printers[mac]
}
