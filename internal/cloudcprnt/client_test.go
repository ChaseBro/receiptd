package cloudcprnt

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// verify mirrors worker/src/auth.ts verifyAdminSignature so the test fails
// any time the client drifts from the worker's scheme.
func verify(t *testing.T, r *http.Request, secret string, body []byte) {
	t.Helper()
	sig := r.Header.Get("X-Signature")
	tsHeader := r.Header.Get("X-Timestamp")
	if sig == "" || tsHeader == "" {
		t.Fatalf("missing signature headers: sig=%q ts=%q", sig, tsHeader)
	}
	ts, err := strconv.ParseInt(tsHeader, 10, 64)
	if err != nil {
		t.Fatalf("bad timestamp: %v", err)
	}
	if skew := time.Now().UnixMilli() - ts; skew < 0 {
		skew = -skew
		if skew > 5*60*1000 {
			t.Fatalf("timestamp skew: %dms", skew)
		}
	}
	hash := sha256.Sum256(body)
	signed := tsHeader + "." + r.Method + "." + r.URL.EscapedPath() + "." + hex.EncodeToString(hash[:])
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signed))
	expected := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(sig)) {
		t.Fatalf("signature mismatch: got %s want %s (signed=%q)", sig, expected, signed)
	}
}

func TestClient_NilWhenUnconfigured(t *testing.T) {
	if c := NewClient("", "secret"); c != nil {
		t.Fatalf("expected nil for empty URL, got %+v", c)
	}
	if c := NewClient("https://example.com", ""); c != nil {
		t.Fatalf("expected nil for empty secret, got %+v", c)
	}
}

func TestClient_PostJob(t *testing.T) {
	const secret = "test-secret-1234567890"
	binary := []byte("fake-starprnt-bytes")

	var got struct {
		method, path, printerID, jobID, contentType string
		body                                        []byte
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		verify(t, r, secret, b)
		got.method = r.Method
		got.path = r.URL.Path
		got.printerID = r.Header.Get("X-Printer-Id")
		got.jobID = r.Header.Get("X-Job-Id")
		got.contentType = r.Header.Get("Content-Type")
		got.body = b
		w.WriteHeader(201)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, secret)
	if err := c.PostJob(context.Background(), "printer-abc", "job-123", binary, ""); err != nil {
		t.Fatalf("PostJob: %v", err)
	}
	if got.method != "POST" || got.path != "/admin/jobs" {
		t.Fatalf("wrong route: %s %s", got.method, got.path)
	}
	if got.printerID != "printer-abc" || got.jobID != "job-123" {
		t.Fatalf("missing headers: %+v", got)
	}
	if got.contentType != "application/vnd.star.starprnt" {
		t.Fatalf("content type: %q", got.contentType)
	}
	if string(got.body) != string(binary) {
		t.Fatalf("body mismatch")
	}
}

func TestClient_PutPrinterSecret(t *testing.T) {
	const secret = "test-secret-1234567890"
	const printerSecret = "basic-pw-supersecretvalue"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		verify(t, r, secret, b)
		if r.Method != "PUT" || r.URL.EscapedPath() != "/admin/printers/p%2Fwith%20slash/secret" {
			t.Errorf("path escaping broken: %s %s", r.Method, r.URL.EscapedPath())
		}
		if !strings.Contains(string(b), `"secret"`) {
			t.Errorf("body missing secret field: %s", b)
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, secret)
	if err := c.PutPrinterSecret(context.Background(), "p/with slash", printerSecret); err != nil {
		t.Fatalf("PutPrinterSecret: %v", err)
	}
}

func TestClient_ErrorStatusSurfaces(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "signature mismatch", 401)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "secret-1234567890xxxx")
	err := c.PostJob(context.Background(), "p", "j", []byte("x"), "")
	if err == nil {
		t.Fatal("expected error on 401")
	}
	if !strings.Contains(err.Error(), "401") || !strings.Contains(err.Error(), "signature mismatch") {
		t.Fatalf("error should surface status + body: %v", err)
	}
}
