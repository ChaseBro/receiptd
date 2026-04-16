package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
)

type fakeVerifier struct {
	accept string
	id     *Identity
}

func (f *fakeVerifier) Verify(ctx context.Context, token string) (*Identity, error) {
	if token == f.accept {
		return f.id, nil
	}
	return nil, errors.New("bad token")
}

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := IdentityFromContext(r.Context())
		if id == nil {
			http.Error(w, "no identity", http.StatusInternalServerError)
			return
		}
		w.Header().Set("X-Identity-Kind", id.Kind)
		w.WriteHeader(http.StatusOK)
	})
}

func TestAuth_LoopbackBypass(t *testing.T) {
	mw := AuthMiddleware(AuthConfig{Logger: zerolog.Nop()})
	srv := httptest.NewServer(mw(okHandler()))
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("loopback got %d, want 200", resp.StatusCode)
	}
	if resp.Header.Get("X-Identity-Kind") != "loopback" {
		t.Fatalf("identity kind = %q, want loopback", resp.Header.Get("X-Identity-Kind"))
	}
}

func TestAuth_LoopbackBypass_Disabled(t *testing.T) {
	// RequireAuthOnLoopback forces token even for 127.0.0.1 — simulates public mode.
	mw := AuthMiddleware(AuthConfig{
		Verifier:              &fakeVerifier{accept: "good", id: &Identity{Kind: "user", Subject: "u1"}},
		RequireAuthOnLoopback: true,
		Logger:                zerolog.Nop(),
	})
	srv := httptest.NewServer(mw(okHandler()))
	defer srv.Close()

	// No auth → 401
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", resp.StatusCode)
	}

	// With valid token → 200
	req, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req.Header.Set("Authorization", "Bearer good")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("got %d, want 200", resp2.StatusCode)
	}
	if resp2.Header.Get("X-Identity-Kind") != "user" {
		t.Fatalf("identity = %q, want user", resp2.Header.Get("X-Identity-Kind"))
	}

	// Bad token → 401
	req3, _ := http.NewRequest(http.MethodGet, srv.URL, nil)
	req3.Header.Set("Authorization", "Bearer nope")
	resp3, err := http.DefaultClient.Do(req3)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusUnauthorized {
		t.Fatalf("got %d, want 401", resp3.StatusCode)
	}
}

func TestAuth_HasScope(t *testing.T) {
	id := &Identity{Kind: "user", Scopes: []string{"jobs:write"}}
	if !id.HasScope("jobs:write") {
		t.Fatal("expected jobs:write scope to be granted")
	}
	if id.HasScope("render") {
		t.Fatal("did not expect render scope")
	}

	admin := &Identity{Kind: "user", Scopes: []string{"admin"}}
	if !admin.HasScope("anything") {
		t.Fatal("admin should satisfy every scope")
	}

	loop := &Identity{Kind: "loopback"}
	if !loop.HasScope("anything") {
		t.Fatal("loopback should always satisfy any scope")
	}

	var nilID *Identity
	if nilID.HasScope("jobs:write") {
		t.Fatal("nil identity should not satisfy any scope")
	}
}

func TestAuth_ExtractBearer(t *testing.T) {
	cases := []struct {
		header string
		want   string
	}{
		{"", ""},
		{"Bearer abc", "abc"},
		{"Bearer   abc  ", "abc"},
		{"abc", "abc"},
	}
	for _, c := range cases {
		r, _ := http.NewRequest(http.MethodGet, "/", nil)
		if c.header != "" {
			r.Header.Set("Authorization", c.header)
		}
		got := extractBearer(r)
		if got != c.want {
			t.Errorf("extractBearer(%q) = %q, want %q", c.header, got, c.want)
		}
	}
}

func TestAuth_IsLoopback(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:54321":     true,
		"[::1]:54321":         true,
		"localhost:54321":     true,
		"192.168.1.5:3000":    false,
		"10.0.0.1:3000":       false,
		"printer.example:80":  false,
	}
	for addr, want := range cases {
		if got := isLoopback(addr); got != want {
			t.Errorf("isLoopback(%q) = %v, want %v", addr, got, want)
		}
	}
}
