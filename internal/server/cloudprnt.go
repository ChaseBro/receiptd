package server

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// CloudPRNTHandler handles the CloudPRNT protocol
type CloudPRNTHandler struct {
	queue   *Queue
	printer string // printer ID to use (empty = any)
}

// NewCloudPRNTHandler creates a new CloudPRNT handler
func NewCloudPRNTHandler(queue *Queue, printerID string) *CloudPRNTHandler {
	return &CloudPRNTHandler{
		queue:   queue,
		printer: printerID,
	}
}

// ServeHTTP handles CloudPRNT requests
func (h *CloudPRNTHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	log.Printf("[CloudPRNT] %s %s", r.Method, r.URL.Path)
	
	switch r.Method {
	case http.MethodPost:
		h.handlePoll(w, r)
	case http.MethodGet:
		h.handleGetJob(w, r)
	case http.MethodDelete:
		h.handleComplete(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handlePoll handles POST /cloudprnt - printer polls for jobs
func (h *CloudPRNTHandler) handlePoll(w http.ResponseWriter, r *http.Request) {
	// Parse printer identification from headers
	mac := r.Header.Get("X-Star-MAC-Address")
	serial := r.Header.Get("X-Star-Serial-Number")
	status := r.Header.Get("X-Star-Status")
	
	log.Printf("[CloudPRNT] Poll from printer: MAC=%s Serial=%s Status=%s", mac, serial, status)
	
	// Find pending job for this printer (or any if no specific printer)
	job := h.queue.GetPendingForPrinter(h.printer)
	
	if job == nil {
		// No job - tell printer to come back later
		w.WriteHeader(http.StatusNoContent)
		return
	}
	
	// Mark job as processing
	h.queue.StartProcessing(job.ID)
	
	// Return job token to printer
	w.Header().Set("Content-Type", "application/json")
	resp := map[string]string{
		"token": job.ID,
		"type":  "text/vnd.star.markup",
	}
	json.NewEncoder(w).Encode(resp)
	log.Printf("[CloudPRNT] Job ready: %s", job.ID)
}

// handleGetJob handles GET /cloudprnt?token=X - printer fetches job content
func (h *CloudPRNTHandler) handleGetJob(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "Missing token", http.StatusBadRequest)
		return
	}
	
	job := h.queue.Get(token)
	if job == nil {
		http.Error(w, "Job not found", http.StatusNotFound)
		return
	}
	
	// Return the print content
	w.Header().Set("Content-Type", "text/vnd.star.markup")
	w.Header().Set("X-Job-ID", job.ID)
	
	// Add content length
	content := job.Content
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	
	fmt.Fprint(w, content)
	log.Printf("[CloudPRNT] Job content served: %s", token)
}

// handleComplete handles DELETE /cloudprnt?token=X&code=0 - printer confirms completion
func (h *CloudPRNTHandler) handleComplete(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	code := r.URL.Query().Get("code")
	
	if token == "" {
		http.Error(w, "Missing token", http.StatusBadRequest)
		return
	}
	
	success := code == "0" || code == ""
	errMsg := ""
	if !success {
		errMsg = fmt.Sprintf("Printer reported error code: %s", code)
	}
	
	h.queue.Complete(token, success, errMsg)
	
	w.WriteHeader(http.StatusNoContent)
	log.Printf("[CloudPRNT] Job complete: %s success=%v", token, success)
}

// PrinterInfo holds printer information
type PrinterInfo struct {
	MACAddress     string    `json:"macAddress"`
	SerialNumber   string    `json:"serialNumber"`
	Status         string    `json:"status"`
	LastSeen       time.Time `json:"lastSeen"`
	Capabilities   []string  `json:"capabilities,omitempty"`
}

// PrinterRegistry manages known printers
type PrinterRegistry struct {
	printers map[string]*PrinterInfo
	mu       sync.RWMutex
}

// NewPrinterRegistry creates a new printer registry
func NewPrinterRegistry() *PrinterRegistry {
	return &PrinterRegistry{
		printers: make(map[string]*PrinterInfo),
	}
}

// Register records a printer from a CloudPRNT poll
func (r *PrinterRegistry) Register(mac string, info *PrinterInfo) {
	r.mu.Lock()
	defer r.mu.Unlock()
	info.LastSeen = time.Now()
	r.printers[mac] = info
}

// Get returns printer info by MAC
func (r *PrinterRegistry) Get(mac string) *PrinterInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.printers[mac]
}

// List returns all known printers
func (r *PrinterRegistry) List() []*PrinterInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	
	result := make([]*PrinterInfo, 0, len(r.printers))
	for _, p := range r.printers {
		result = append(result, p)
	}
	return result
}

// Required headers from CloudPRNT spec:
// X-Star-MAC-Address
// X-Star-Serial-Number
// X-Star-Status
// X-Star-Support-Protocols
// X-Star-Paper-Width
// X-Star-Print-Width
// X-Star-Horizontal-Resolution
// X-Star-Vertical-Resolution