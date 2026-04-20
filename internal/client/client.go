// Package client is the CLI's handle to a running receiptd. It talks to the
// local daemon over a JSON-over-TCP protocol (today) OR to a remote daemon
// over the /v1 HTTPS REST API (when RECEIPTD_API / --api is set).
//
// Callers use the same method surface regardless of transport; the Client
// struct dispatches internally based on its Mode.
package client

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// Response is the TCP-protocol response wrapper. Preserved as the public
// return type so existing CLI call sites don't need sweeping changes; HTTP
// transports synthesize Response values that look the same.
type Response struct {
	Status  string      `json:"status"`
	Message string      `json:"message,omitempty"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

// Mode reports which transport the Client uses.
type Mode int

const (
	ModeTCP  Mode = iota // local JSON-over-TCP to the daemon on :3099
	ModeHTTP             // remote /v1 REST, HTTPS or HTTP
)

// Client communicates with a running receiptd.
type Client struct {
	mode       Mode
	tcpAddress string
	httpBase   string // e.g. "https://api.receiptd.sh" (no trailing slash)
	httpClient *http.Client
	apiKey     string // bearer token, if any
}

// NewClient builds a Client using the standard resolution chain:
//
//  1. RECEIPTD_API env var (or --api flag via override) → HTTP mode
//  2. otherwise → local TCP mode
//
// RECEIPTD_API_KEY (or --api-key) supplies the bearer token when in HTTP mode.
// Local mode never requires a token because the daemon bypasses auth on
// loopback.
func NewClient() *Client {
	return NewClientFromConfig(ClientConfig{
		APIURL: os.Getenv("RECEIPTD_API"),
		APIKey: os.Getenv("RECEIPTD_API_KEY"),
	})
}

// ClientConfig is explicit transport config, typically supplied by CLI flags
// that override the environment defaults.
type ClientConfig struct {
	APIURL string // http(s)://host[:port]
	APIKey string // bearer token
}

// NewClientFromConfig builds a Client from an explicit config, falling back
// to TCP when APIURL is empty.
func NewClientFromConfig(cfg ClientConfig) *Client {
	if cfg.APIURL != "" {
		return &Client{
			mode:       ModeHTTP,
			httpBase:   strings.TrimRight(cfg.APIURL, "/"),
			httpClient: &http.Client{Timeout: 30 * time.Second},
			apiKey:     cfg.APIKey,
		}
	}
	return &Client{
		mode:       ModeTCP,
		tcpAddress: "127.0.0.1:3099",
	}
}

// Mode returns the active transport.
func (c *Client) CurrentMode() Mode { return c.mode }

// --- TCP transport ------------------------------------------------------

// Connect establishes a TCP connection to the local daemon.
func (c *Client) Connect() (net.Conn, error) {
	conn, err := net.DialTimeout("tcp", c.tcpAddress, 2*time.Second)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to server: %w", err)
	}
	return conn, nil
}

// SendCommand sends a TCP command. HTTP-mode clients must not call this.
func (c *Client) SendCommand(cmd string, payload interface{}) (*Response, error) {
	if c.mode != ModeTCP {
		return nil, fmt.Errorf("SendCommand is TCP-only; client is in HTTP mode")
	}
	conn, err := c.Connect()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(10 * time.Second))

	req := map[string]interface{}{
		"command": cmd,
		"payload": payload,
	}

	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return nil, fmt.Errorf("send failed: %w", err)
	}

	var resp Response
	if err := json.NewDecoder(conn).Decode(&resp); err != nil {
		return nil, fmt.Errorf("read failed: %w", err)
	}

	if resp.Error != "" {
		return &resp, fmt.Errorf("%s", resp.Error)
	}

	return &resp, nil
}

// --- HTTP transport -----------------------------------------------------

// doJSON issues a JSON HTTP request to the /v1 API and decodes the body into
// dst (if non-nil). Returns a synthetic Response shaped like the TCP one.
func (c *Client) doJSON(method, path string, body interface{}, dst interface{}) (*Response, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal body: %w", err)
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.httpBase+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	rawBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode >= 400 {
		var e struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		_ = json.Unmarshal(rawBody, &e)
		msg := e.Error
		if msg == "" {
			msg = strings.TrimSpace(string(rawBody))
		}
		return &Response{Status: "error", Error: msg}, fmt.Errorf("api %d: %s", resp.StatusCode, msg)
	}

	if dst != nil && len(rawBody) > 0 {
		if err := json.Unmarshal(rawBody, dst); err != nil {
			return nil, fmt.Errorf("decode response: %w", err)
		}
	}
	return &Response{Status: "ok", Data: dst}, nil
}

// --- command facades (transport-agnostic) -------------------------------

// Status gets server status.
func (c *Client) Status() (*Response, error) {
	if c.mode == ModeHTTP {
		var body map[string]interface{}
		return c.doJSON(http.MethodGet, "/v1/healthz", nil, &body)
	}
	return c.SendCommand("status", nil)
}

// JobRequest is the path-free shape of a print job (what HTTP clients
// should send). Exactly one of Text, HTML, or ImageBytes must be set.
// TCP callers keep using AddJob, which carries on the legacy path-based
// shape for backward compat.
type JobRequest struct {
	PrinterID string
	Staged    bool

	Text       string
	HTML       string
	ImageBytes []byte
	Caption    string

	Dither     string
	Brightness int
	Contrast   int
	Gamma      float64
}

// CreateJob is the HTTP-mode entry point for submitting a print job. The
// TCP daemon is not supported — callers on localhost without --api should
// keep using AddJob until the TCP server is fully retired.
func (c *Client) CreateJob(req JobRequest) (*Response, error) {
	if c.mode != ModeHTTP {
		return nil, fmt.Errorf("CreateJob requires HTTP mode; set --api or RECEIPTD_API")
	}
	payload := map[string]interface{}{"staged": req.Staged}
	if req.PrinterID != "" {
		payload["printerId"] = req.PrinterID
	}
	if req.Text != "" {
		payload["text"] = req.Text
	}
	if req.HTML != "" {
		payload["html"] = req.HTML
	}
	if len(req.ImageBytes) > 0 {
		payload["imageData"] = base64.StdEncoding.EncodeToString(req.ImageBytes)
	}
	if req.Caption != "" {
		payload["caption"] = req.Caption
	}
	if req.Dither != "" {
		payload["dither"] = req.Dither
	}
	if req.Brightness != 0 {
		payload["brightness"] = req.Brightness
	}
	if req.Contrast != 0 {
		payload["contrast"] = req.Contrast
	}
	if req.Gamma != 0 {
		payload["gamma"] = req.Gamma
	}

	var body map[string]interface{}
	resp, err := c.doJSON(http.MethodPost, "/v1/jobs", payload, &body)
	if err != nil {
		return resp, err
	}
	if id, ok := body["id"].(string); ok {
		resp.Data = id
	}
	return resp, nil
}

// AddJob submits a print job. imagePath may be an absolute local path or URL
// (file://, https://, data:). If staged is true the job is held and never
// dispatched to the printer.
func (c *Client) AddJob(printerID, content, imagePath string, staged bool) (*Response, error) {
	if c.mode == ModeHTTP {
		payload := map[string]interface{}{
			"printerId": printerID,
			"content":   content,
			"staged":    staged,
		}
		if imagePath != "" {
			payload["imagePath"] = imagePath
		}
		var body map[string]interface{}
		resp, err := c.doJSON(http.MethodPost, "/v1/jobs", payload, &body)
		if err != nil {
			return resp, err
		}
		// Mirror the TCP response shape: top-level Data is the job ID string.
		if id, ok := body["id"].(string); ok {
			resp.Data = id
		}
		return resp, nil
	}

	payload := map[string]interface{}{
		"printerId": printerID,
		"content":   content,
		"staged":    staged,
	}
	if imagePath != "" {
		payload["imagePath"] = imagePath
	}
	return c.SendCommand("add_job", payload)
}

// GetJobs lists jobs in the queue.
func (c *Client) GetJobs() (*Response, error) {
	if c.mode == ModeHTTP {
		var list []map[string]interface{}
		return c.doJSON(http.MethodGet, "/v1/jobs", nil, &list)
	}
	return c.SendCommand("get_jobs", nil)
}

// GetPrinters gets known printers. Not yet implemented over HTTP.
func (c *Client) GetPrinters() (*Response, error) {
	if c.mode == ModeHTTP {
		return nil, fmt.Errorf("get_printers not yet available over HTTP")
	}
	return c.SendCommand("get_printers", nil)
}

// IsServerRunning checks if the daemon is reachable. For HTTP mode, does a
// GET /v1/healthz. For TCP mode, attempts a TCP connect.
func (c *Client) IsServerRunning() bool {
	if c.mode == ModeHTTP {
		_, err := c.Status()
		return err == nil
	}
	conn, err := net.DialTimeout("tcp", c.tcpAddress, 500*time.Millisecond)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
