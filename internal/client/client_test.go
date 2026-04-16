package client

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewClient_HTTPModeFromEnv(t *testing.T) {
	t.Setenv("RECEIPTD_API", "https://api.example.com")
	t.Setenv("RECEIPTD_API_KEY", "secret")
	c := NewClient()
	if c.CurrentMode() != ModeHTTP {
		t.Fatalf("mode = %d, want ModeHTTP", c.CurrentMode())
	}
	if c.httpBase != "https://api.example.com" {
		t.Fatalf("httpBase = %q", c.httpBase)
	}
	if c.apiKey != "secret" {
		t.Fatalf("apiKey not propagated")
	}
}

func TestNewClient_TCPDefault(t *testing.T) {
	t.Setenv("RECEIPTD_API", "")
	c := NewClient()
	if c.CurrentMode() != ModeTCP {
		t.Fatalf("mode = %d, want ModeTCP", c.CurrentMode())
	}
}

// HTTP client ↔ REST server smoke test using a stub server that mirrors the
// /v1 shape (success + bearer + error paths).
func TestClient_HTTP_AddJob_AndGetJobs(t *testing.T) {
	var gotAuth string
	var gotBody map[string]interface{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/jobs":
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &gotBody)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"job-abc123","content":"hi[feed:3][cut]"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/jobs":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"id":"job-abc123"}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/healthz":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			http.Error(w, "unexpected", http.StatusTeapot)
		}
	}))
	defer srv.Close()

	c := NewClientFromConfig(ClientConfig{APIURL: srv.URL, APIKey: "token-xyz"})

	resp, err := c.AddJob("printer-1", "hi", "", false)
	if err != nil {
		t.Fatalf("AddJob: %v", err)
	}
	if id, _ := resp.Data.(string); id != "job-abc123" {
		t.Fatalf("Data = %v, want job-abc123", resp.Data)
	}
	if !strings.HasPrefix(gotAuth, "Bearer ") {
		t.Fatalf("Authorization header missing: %q", gotAuth)
	}
	if gotBody["content"] != "hi" {
		t.Fatalf("body.content = %v", gotBody["content"])
	}

	resp2, err := c.GetJobs()
	if err != nil {
		t.Fatalf("GetJobs: %v", err)
	}
	if resp2.Status != "ok" {
		t.Fatalf("Status = %q", resp2.Status)
	}

	if !c.IsServerRunning() {
		t.Fatalf("IsServerRunning should be true against stub")
	}
}

func TestClient_HTTP_ErrorResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"content or imagePath required","code":"empty_job"}`))
	}))
	defer srv.Close()

	c := NewClientFromConfig(ClientConfig{APIURL: srv.URL})
	_, err := c.AddJob("", "", "", false)
	if err == nil {
		t.Fatal("expected error on 400 response")
	}
	if !strings.Contains(err.Error(), "content or imagePath required") {
		t.Fatalf("error = %v, want server-provided message", err)
	}
}
