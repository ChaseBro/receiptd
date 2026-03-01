package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/ChaseBro/receiptd/internal/db"
	"github.com/rs/zerolog"
)

type CloudPRNTHandler struct {
	daemon     *Daemon
	logger     zerolog.Logger
	cputilPath string
	mediaTypes []string
}

func resolveCputilPath() string {
	// 1. Explicit env var
	if p := os.Getenv("CPUTIL_PATH"); p != "" {
		return p
	}
	// 2. cputil on PATH
	if p, err := exec.LookPath("cputil"); err == nil {
		return p
	}
	return ""
}

func NewCloudPRNTHandler(daemon *Daemon, logger zerolog.Logger) (*CloudPRNTHandler, error) {
	cputilPath := resolveCputilPath()
	if cputilPath == "" {
		return nil, fmt.Errorf("cputil not found: set CPUTIL_PATH or add cputil to PATH")
	}
	return &CloudPRNTHandler{
		daemon:     daemon,
		logger:     logger,
		cputilPath: cputilPath,
		mediaTypes: []string{"text/vnd.star.markup", "text/plain"},
	}, nil
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

// pollBody is the JSON body sent by the Star printer on each POST poll.
type pollBody struct {
	PrinterMAC         string         `json:"printerMAC"`
	StatusCode         string         `json:"statusCode"`
	PrintingInProgress bool           `json:"printingInProgress"`
	ClientAction       []clientAction `json:"clientAction"`
}

type clientAction struct {
	Request string          `json:"request"`
	Result  json.RawMessage `json:"result"`
}

type pageInfo struct {
	PrintWidth          int     `json:"printWidth"`
	HorizontalResolution float64 `json:"horizontalResolution"`
}

func (h *CloudPRNTHandler) handlePoll(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)

	var poll pollBody
	if len(body) > 0 {
		json.Unmarshal(body, &poll)
	}

	// Fall back to header if printerMAC not in body
	mac := poll.PrinterMAC
	if mac == "" {
		mac = r.Header.Get("X-Star-Mac")
	}

	h.logger.Info().Str("mac", mac).RawJSON("body", body).Msg("Printer poll")

	// Persist printer info to DB
	if mac != "" {
		h.upsertPrinterFromPoll(mac, r.RemoteAddr, &poll)
	}

	queue := h.daemon.queue

	// Log queue state on every poll for debugging
	pending, processing := queue.CountByStatus()
	h.logger.Debug().Int("pending", pending).Int("processing", processing).Msg("Queue state")

	// Warn about stale processing jobs (stuck > 30s means printer never DELETEd)
	stale := queue.GetStaleProcessing(30 * time.Second)
	for _, sj := range stale {
		h.logger.Warn().Str("job_id", sj.ID).Dur("age", time.Since(*sj.StartedAt)).Msg("Stale processing job — printer may have missed it; resetting to pending")
		queue.ResetToPending(sj.ID)
	}

	// Atomically check for in-flight jobs, find next pending, and mark it processing.
	job := h.daemon.takeNextJob(mac)

	if job == nil {
		h.logger.Debug().Int("pending", pending).Int("processing", processing).Msg("No job available (busy or empty)")
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

	job := h.daemon.queue.Get(token)
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

	markup := job.Content
	if job.ImagePath != "" {
		// Prepend image tag; use file:// scheme for absolute local paths.
		url := job.ImagePath
		if !strings.HasPrefix(url, "file://") && !strings.HasPrefix(url, "http://") &&
			!strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "data:") {
			url = "file://" + url
		}
		markup = fmt.Sprintf("[image: url %s; width 100%%]\n", url) + markup
	}

	binary, err := h.convertToStarPRNT(markup)
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

	ok := h.daemon.acknowledgeJob(token, success, "")
	if !ok {
		h.logger.Warn().Str("token", token).Msg("DELETE for unknown token — job may have already been removed")
	}

	w.WriteHeader(http.StatusNoContent)
}

// upsertPrinterFromPoll extracts printer info from a poll and writes it to the DB.
func (h *CloudPRNTHandler) upsertPrinterFromPoll(mac, remoteAddr string, poll *pollBody) {
	now := time.Now()

	p := &db.Printer{
		ID:             mac,
		MACAddress:     mac,
		LastStatusCode: poll.StatusCode,
		LastSeenAt:     now,
		RegisteredAt:   now, // preserved on upsert conflict
	}

	// Extract IP from RemoteAddr (host:port)
	if host, _, err := parseHostPort(remoteAddr); err == nil {
		p.IPAddress = host
	}

	// Parse clientAction entries
	for _, ca := range poll.ClientAction {
		switch ca.Request {
		case "PageInfo":
			var pi pageInfo
			if err := json.Unmarshal(ca.Result, &pi); err == nil {
				p.PrintWidth = pi.PrintWidth
				p.HorizontalRes = pi.HorizontalResolution
				if pi.HorizontalResolution > 0 {
					p.DotWidth = int(float64(pi.PrintWidth) * pi.HorizontalResolution)
				}
			}
		case "ClientType":
			var ct string
			if err := json.Unmarshal(ca.Result, &ct); err == nil {
				p.ClientType = ct
			}
		case "ClientVersion":
			var cv string
			if err := json.Unmarshal(ca.Result, &cv); err == nil {
				p.ClientVersion = cv
			}
		}
	}

	if err := h.daemon.db.UpsertPrinter(p); err != nil {
		h.logger.Error().Err(err).Str("mac", mac).Msg("Failed to upsert printer in DB")
	}
}

// parseHostPort splits a host:port string, returning the host.
func parseHostPort(addr string) (host, port string, err error) {
	// net.SplitHostPort handles IPv6 [::1]:port too
	idx := strings.LastIndex(addr, ":")
	if idx < 0 {
		return addr, "", nil
	}
	return addr[:idx], addr[idx+1:], nil
}

// PrinterRegistry is kept for compatibility but the DB is now authoritative.
type PrinterRegistry struct{}

func NewPrinterRegistry() *PrinterRegistry {
	return &PrinterRegistry{}
}
