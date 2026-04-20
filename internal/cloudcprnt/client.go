// Package cloudcprnt is the Fly → Cloudflare Worker admin client. It ships
// pre-rendered StarPRNT binaries to the worker's /admin/jobs endpoint and
// provisions per-printer HTTP Basic secrets for worker-side printer auth.
//
// Runtime picks local-only vs cloud-mode via env: if RECEIPTD_WORKER_URL and
// RECEIPTD_WORKER_HMAC_SECRET are both set, NewClientFromEnv returns a live
// client; otherwise it returns nil and Jobs.Create behaves exactly as today.
//
// Signing scheme (must match worker/src/auth.ts verifyAdminSignature):
//
//	signed    = "<timestamp_ms>.<METHOD>.<path>.<sha256_hex(body)>"
//	signature = hex(HMAC-SHA256(shared_secret, signed))
//	headers   = X-Timestamp, X-Signature
//	skew      = ±5 minutes (worker rejects outside that window)
package cloudcprnt

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Client talks to the receiptd CloudPRNT worker admin API.
type Client struct {
	baseURL string
	secret  string
	http    *http.Client
}

// NewClient builds a Client. baseURL is the worker origin (e.g.
// https://cprnt.receiptd.sh); trailing slashes are trimmed. secret is the
// shared HMAC key. Both must be non-empty or NewClient returns nil — callers
// interpret nil as "local-only mode".
func NewClient(baseURL, secret string) *Client {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	secret = strings.TrimSpace(secret)
	if baseURL == "" || secret == "" {
		return nil
	}
	return &Client{
		baseURL: baseURL,
		secret:  secret,
		http:    &http.Client{Timeout: 30 * time.Second},
	}
}

// NewClientFromEnv reads RECEIPTD_WORKER_URL + RECEIPTD_WORKER_HMAC_SECRET.
// Returns nil if either is unset — cloud-mode is opt-in.
func NewClientFromEnv() *Client {
	return NewClient(os.Getenv("RECEIPTD_WORKER_URL"), os.Getenv("RECEIPTD_WORKER_HMAC_SECRET"))
}

// BaseURL returns the worker origin this client is pointed at.
func (c *Client) BaseURL() string { return c.baseURL }

// PostJob uploads a StarPRNT binary and signals the printer that a job is
// ready. Content-Type defaults to application/vnd.star.starprnt.
func (c *Client) PostJob(ctx context.Context, printerID, jobID string, binary []byte, contentType string) error {
	if printerID == "" || jobID == "" {
		return fmt.Errorf("cloudcprnt: printerID and jobID required")
	}
	if len(binary) == 0 {
		return fmt.Errorf("cloudcprnt: empty binary")
	}
	if contentType == "" {
		contentType = "application/vnd.star.starprnt"
	}
	req, err := c.newSignedRequest(ctx, http.MethodPost, "/admin/jobs", binary)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Printer-Id", printerID)
	req.Header.Set("X-Job-Id", jobID)
	return c.do(req, "post job")
}

// PutPrinterSecret provisions (or rotates) the HTTP Basic password the
// printer will present on its CloudPRNT polls. The worker stores the raw
// secret in KV; pairing flow should generate high-entropy values.
func (c *Client) PutPrinterSecret(ctx context.Context, printerID, secret string) error {
	if printerID == "" {
		return fmt.Errorf("cloudcprnt: printerID required")
	}
	if len(secret) < 16 {
		return fmt.Errorf("cloudcprnt: secret must be at least 16 chars")
	}
	body, _ := json.Marshal(struct {
		Secret string `json:"secret"`
	}{Secret: secret})
	path := "/admin/printers/" + url.PathEscape(printerID) + "/secret"
	req, err := c.newSignedRequest(ctx, http.MethodPut, path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, "put printer secret")
}

// PrinterStatus mirrors the worker's KV status snapshot (see
// worker/src/status.ts PrinterStatus). Unix-millisecond timestamps.
type PrinterStatus struct {
	StatusCode         string `json:"statusCode,omitempty"`
	MAC                string `json:"mac,omitempty"`
	ClientType         string `json:"clientType,omitempty"`
	ClientVersion      string `json:"clientVersion,omitempty"`
	// PrintWidth is a float because different TSP firmware reports inches
	// (2.835) vs. raw dots (576). Callers multiply by HorizontalRes when
	// they need dot count.
	PrintWidth         float64 `json:"printWidth,omitempty"`
	HorizontalRes      float64 `json:"horizontalRes,omitempty"`
	PrintingInProgress bool   `json:"printingInProgress,omitempty"`
	LastSeenAt         int64  `json:"lastSeenAt"`
	LastChangeAt       int64  `json:"lastChangeAt"`
}

// ErrNoStatus is returned by GetPrinterStatus when the printer has never
// polled the worker (or its status TTL has expired).
var ErrNoStatus = fmt.Errorf("cloudcprnt: no status recorded")

// GetPrinterStatus fetches the worker's last-seen status for a printer.
// Returns ErrNoStatus on 404. HMAC-signed with an empty body.
func (c *Client) GetPrinterStatus(ctx context.Context, printerID string) (*PrinterStatus, error) {
	if printerID == "" {
		return nil, fmt.Errorf("cloudcprnt: printerID required")
	}
	path := "/admin/printers/" + url.PathEscape(printerID) + "/status"
	req, err := c.newSignedRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cloudcprnt get status: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, ErrNoStatus
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("cloudcprnt get status: %s: %s", resp.Status, strings.TrimSpace(string(snippet)))
	}
	var out PrinterStatus
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode status: %w", err)
	}
	return &out, nil
}

// DeletePrinterSecret revokes the printer's credential and clears any
// pending job signal for it.
func (c *Client) DeletePrinterSecret(ctx context.Context, printerID string) error {
	if printerID == "" {
		return fmt.Errorf("cloudcprnt: printerID required")
	}
	path := "/admin/printers/" + url.PathEscape(printerID) + "/secret"
	req, err := c.newSignedRequest(ctx, http.MethodDelete, path, nil)
	if err != nil {
		return err
	}
	return c.do(req, "delete printer secret")
}

// newSignedRequest builds an http.Request with HMAC signing headers. path
// must begin with "/" and be the raw path the worker sees — it is hashed
// into the signature, so any proxy that rewrites the path will invalidate.
func (c *Client) newSignedRequest(ctx context.Context, method, path string, body []byte) (*http.Request, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, fmt.Errorf("cloudcprnt: path must start with /")
	}
	var bodyReader io.Reader
	if len(body) > 0 {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, err
	}
	if len(body) > 0 {
		req.ContentLength = int64(len(body))
	}

	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	bodyHash := sha256.Sum256(body) // nil body → hash of empty, same as worker
	signed := ts + "." + method + "." + path + "." + hex.EncodeToString(bodyHash[:])

	mac := hmac.New(sha256.New, []byte(c.secret))
	mac.Write([]byte(signed))
	sig := hex.EncodeToString(mac.Sum(nil))

	req.Header.Set("X-Timestamp", ts)
	req.Header.Set("X-Signature", sig)
	return req, nil
}

func (c *Client) do(req *http.Request, opName string) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("cloudcprnt %s: %w", opName, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		// Drain so the connection can be reused.
		io.Copy(io.Discard, resp.Body)
		return nil
	}
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return fmt.Errorf("cloudcprnt %s: %s: %s", opName, resp.Status, strings.TrimSpace(string(snippet)))
}
