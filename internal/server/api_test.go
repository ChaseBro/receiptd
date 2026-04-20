package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/ChaseBro/receiptd/internal/db"
	"github.com/ChaseBro/receiptd/internal/jobs"
	"github.com/ChaseBro/receiptd/internal/services"
	"github.com/rs/zerolog"
)

// newTestDaemon builds a Daemon with a temp DataDir and no network listeners.
// Sufficient for testing APIHandler directly against httptest.
func newTestDaemon(t *testing.T) *Daemon {
	t.Helper()
	dir := t.TempDir()
	database, err := db.Open(dir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { database.Close() })
	queue := jobs.NewQueue()
	log := zerolog.Nop()
	return &Daemon{
		config: &Config{DataDir: dir},
		queue:  queue,
		db:     database,
		jobs:   services.NewJobs(queue, database, nil, dir, log),
		render: services.NewRender(dir, log),
		logger: log,
	}
}

func newTestAPI(t *testing.T) (*httptest.Server, *Daemon) {
	t.Helper()
	d := newTestDaemon(t)
	mux := http.NewServeMux()
	NewAPIHandler(d, zerolog.Nop()).Register(mux)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, d
}

func TestAPI_Healthz(t *testing.T) {
	srv, _ := newTestAPI(t)
	resp, err := http.Get(srv.URL + "/v1/healthz")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var body map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["ok"] != true {
		t.Fatalf("ok = %v, want true", body["ok"])
	}
}

func TestAPI_CreateJob_Then_Get(t *testing.T) {
	srv, d := newTestAPI(t)

	reqBody, _ := json.Marshal(createJobRequest{
		Text:   "hello world",
		Staged: true,
	})
	resp, err := http.Post(srv.URL+"/v1/jobs", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, body = %s", resp.StatusCode, b)
	}
	var created jobs.Job
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.ID == "" {
		t.Fatal("empty job ID")
	}
	if !created.Staged {
		t.Fatal("staged flag lost")
	}

	// AddJob appends "[feed:3][cut]" — assert it's present so we know the same
	// code path as the TCP server ran, not a divergent one.
	if !bytes.Contains([]byte(created.Content), []byte("[feed:3][cut]")) {
		t.Fatalf("content missing cut suffix: %q", created.Content)
	}

	// Fetch by ID.
	resp2, err := http.Get(srv.URL + "/v1/jobs/" + created.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("get status = %d", resp2.StatusCode)
	}
	var fetched jobs.Job
	if err := json.NewDecoder(resp2.Body).Decode(&fetched); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if fetched.ID != created.ID {
		t.Fatalf("fetched ID = %q, want %q", fetched.ID, created.ID)
	}

	// In-memory queue should also see it.
	if got := d.queue.Get(created.ID); got == nil {
		t.Fatal("queue.Get returned nil; REST path diverged from daemon state")
	}
}

func TestAPI_CreateJob_EmptyContent(t *testing.T) {
	srv, _ := newTestAPI(t)
	resp, err := http.Post(srv.URL+"/v1/jobs", "application/json", bytes.NewReader([]byte(`{}`)))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestAPI_GetJob_NotFound(t *testing.T) {
	srv, _ := newTestAPI(t)
	resp, err := http.Get(srv.URL + "/v1/jobs/does-not-exist")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestAPI_ListJobs(t *testing.T) {
	srv, _ := newTestAPI(t)
	// Seed two jobs.
	for _, c := range []string{"a", "b"} {
		reqBody, _ := json.Marshal(createJobRequest{Text: c, Staged: true})
		resp, err := http.Post(srv.URL+"/v1/jobs", "application/json", bytes.NewReader(reqBody))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		resp.Body.Close()
	}
	resp, err := http.Get(srv.URL + "/v1/jobs")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	var list []jobs.Job
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("got %d jobs, want 2", len(list))
	}
}

// Verifies that when the daemon is configured to require auth on loopback
// (public mode), the full mux rejects unauthenticated /v1 requests while
// still passing them through with a valid bearer token. This is the exact
// layering cloud deploys will use.
func TestAPI_PublicMode_AuthEnforced(t *testing.T) {
	d := newTestDaemon(t)
	verifier := &fakeVerifier{accept: "good", id: &Identity{Kind: "user", Subject: "u1", Scopes: []string{"jobs:write"}}}

	apiMux := http.NewServeMux()
	NewAPIHandler(d, zerolog.Nop()).Register(apiMux)
	authed := AuthMiddleware(AuthConfig{
		Verifier:              verifier,
		RequireAuthOnLoopback: true,
		Logger:                zerolog.Nop(),
	})(apiMux)

	top := http.NewServeMux()
	top.Handle("/v1/", authed)
	srv := httptest.NewServer(top)
	defer srv.Close()

	// Unauthenticated → 401.
	resp, err := http.Get(srv.URL + "/v1/healthz")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no-token got %d, want 401", resp.StatusCode)
	}

	// With bearer → 200.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/healthz", nil)
	req.Header.Set("Authorization", "Bearer good")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("authed got %d, want 200", resp2.StatusCode)
	}
}

func TestAPI_CloudPRNT_RoutingCoexists(t *testing.T) {
	// Ensure that mounting /v1/* alongside "/" doesn't swallow printer polls at "/".
	// We can't exercise cputil here, but we can verify that a POST to "/" is
	// dispatched away from the API handler.
	d := newTestDaemon(t)
	mux := http.NewServeMux()
	NewAPIHandler(d, zerolog.Nop()).Register(mux)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Served-By", "cloudprnt-stub")
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/", "application/json", nil)
	if err != nil {
		t.Fatalf("post /: %v", err)
	}
	resp.Body.Close()
	if resp.Header.Get("X-Served-By") != "cloudprnt-stub" {
		t.Fatalf("root POST routed to API handler instead of CloudPRNT stub")
	}

	// /v1/healthz should still reach the API.
	resp2, err := http.Get(srv.URL + "/v1/healthz")
	if err != nil {
		t.Fatalf("get /v1/healthz: %v", err)
	}
	resp2.Body.Close()
	if resp2.Header.Get("X-Served-By") == "cloudprnt-stub" {
		t.Fatal("/v1/healthz routed to CloudPRNT stub")
	}
}
