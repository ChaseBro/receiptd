package stub

import (
	"fmt"
	"time"
)

// Stub implementations return mock data to demonstrate CLI UX
// Replace these with real implementations that communicate with the receiptd server

// ServerResult represents server start/stop results
type ServerResult struct {
	Status     string `json:"status"`
	SocketPath string `json:"socket_path"`
	TCPAddress string `json:"tcp_address"`
	PID        int    `json:"pid,omitempty"`
	Message    string `json:"message,omitempty"`
}

// ServerStatus represents the server status
type ServerStatus struct {
	Running            bool   `json:"running"`
	Uptime             string `json:"uptime"`
	Version            string `json:"version"`
	SocketPath         string `json:"socket_path"`
	TCPAddress         string `json:"tcp_address"`
	PrintersConfigured int    `json:"printers_configured"`
	PrintersOnline     int    `json:"printers_online"`
	JobsQueued         int    `json:"jobs_queued"`
	JobsProcessing     int    `json:"jobs_processing"`
}

// Printer represents a receipt printer
type Printer struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Model       string `json:"model"`
	Address     string `json:"address"`
	Status      string `json:"status"`
	IsDefault   bool   `json:"is_default,omitempty"`
	PaperStatus string `json:"paper_status,omitempty"`
	JobsPrinted int    `json:"jobs_printed,omitempty"`
}

// PrintersResult wraps printer lists
type PrintersResult struct {
	Printers []Printer `json:"printers"`
	Count    int       `json:"count,omitempty"`
}

// Job represents a print job
type Job struct {
	ID        string `json:"id"`
	PrinterID string `json:"printer_id"`
	Message   string `json:"message"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

// JobsResult wraps job lists
type JobsResult struct {
	Jobs []Job `json:"jobs"`
}

// PrintResult represents a print job submission
type PrintResult struct {
	JobID     string `json:"job_id"`
	PrinterID string `json:"printer_id"`
	Message   string `json:"message"`
	Status    string `json:"status"`
	Wait      int    `json:"wait,omitempty"`
}

// ConfigResult represents configuration
type ConfigResult struct {
	ConfigPath string                 `json:"config_path"`
	Settings   map[string]interface{} `json:"settings"`
}

// ConfigSetResult represents a config update
type ConfigSetResult struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Status string `json:"status"`
}

// StartServer stub
func StartServer() ServerResult {
	return ServerResult{
		Status:     "started",
		SocketPath: "~/.receiptd/receiptd.sock",
		TCPAddress: "127.0.0.1:3099",
		PID:        12345,
	}
}

// StopServer stub
func StopServer() ServerResult {
	return ServerResult{
		Status:  "stopped",
		Message: "Server stopped successfully",
	}
}

// GetStatus stub
func GetStatus() ServerStatus {
	return ServerStatus{
		Running:            true,
		Uptime:             "2h 15m",
		Version:            "0.1.0-stub",
		SocketPath:         "~/.receiptd/receiptd.sock",
		TCPAddress:         "127.0.0.1:3099",
		PrintersConfigured: 2,
		PrintersOnline:     1,
		JobsQueued:         0,
		JobsProcessing:     1,
	}
}

// Print stub
func Print(message string, printerID string, wait int) PrintResult {
	if printerID == "" {
		printerID = "tsp100-kitchen"
	}

	jobID := fmt.Sprintf("job-%d", time.Now().Unix())

	return PrintResult{
		JobID:     jobID,
		PrinterID: printerID,
		Message:   message,
		Status:    "queued",
		Wait:      wait,
	}
}

// DiscoverPrinters stub
func DiscoverPrinters() PrintersResult {
	printers := []Printer{
		{
			ID:      "tsp100-kitchen",
			Name:    "Kitchen Receipt Printer",
			Model:   "Star TSP100IV",
			Address: "192.168.1.100",
			Status:  "online",
		},
		{
			ID:      "tsp143-bar",
			Name:    "Bar Receipt Printer",
			Model:   "Star TSP143IIIU",
			Address: "192.168.1.101",
			Status:  "online",
		},
	}

	return PrintersResult{
		Printers: printers,
		Count:    len(printers),
	}
}

// ListPrinters stub
func ListPrinters() PrintersResult {
	printers := []Printer{
		{
			ID:        "tsp100-kitchen",
			Name:      "Kitchen Receipt Printer",
			Model:     "Star TSP100IV",
			Status:    "online",
			IsDefault: true,
		},
		{
			ID:        "tsp143-bar",
			Name:      "Bar Receipt Printer",
			Model:     "Star TSP143IIIU",
			Status:    "offline",
			IsDefault: false,
		},
	}

	return PrintersResult{
		Printers: printers,
	}
}

// ShowPrinter stub
func ShowPrinter(id string) Printer {
	return Printer{
		ID:          id,
		Name:        "Kitchen Receipt Printer",
		Model:       "Star TSP100IV",
		Address:     "192.168.1.100",
		Status:      "online",
		PaperStatus: "OK (85%)",
		JobsPrinted: 1247,
		IsDefault:   true,
	}
}

// SetDefaultPrinter stub
func SetDefaultPrinter(id string) ConfigSetResult {
	return ConfigSetResult{
		Key:    "default_printer",
		Value:  id,
		Status: "updated",
	}
}

// ListJobs stub
func ListJobs() JobsResult {
	jobs := []Job{
		{
			ID:        "job-1708435200",
			PrinterID: "tsp100-kitchen",
			Message:   "Test print from receiptd",
			Status:    "processing",
			CreatedAt: "2026-02-20 09:40:00",
		},
		{
			ID:        "job-1708435100",
			PrinterID: "tsp100-kitchen",
			Message:   "Hello, World!",
			Status:    "completed",
			CreatedAt: "2026-02-20 09:38:20",
		},
		{
			ID:        "job-1708435000",
			PrinterID: "tsp143-bar",
			Message:   "Bar order #42",
			Status:    "failed",
			CreatedAt: "2026-02-20 09:36:40",
		},
	}

	return JobsResult{
		Jobs: jobs,
	}
}

// GetConfig stub
func GetConfig() ConfigResult {
	return ConfigResult{
		ConfigPath: "~/.receiptd/config.yaml",
		Settings: map[string]interface{}{
			"default_printer": "tsp100-kitchen",
			"socket_path":     "~/.receiptd/receiptd.sock",
			"tcp_port":        3099,
			"log_level":       "info",
			"auto_discover":   true,
		},
	}
}

// SetConfig stub
func SetConfig(key, value string) ConfigSetResult {
	return ConfigSetResult{
		Key:    key,
		Value:  value,
		Status: "updated",
	}
}
